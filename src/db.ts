import { Database, constants } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import type { CamRow, StoredRow, StoredFeedRow, StoredYtRow, FeedRow, WebcamMatch, YtRow } from "./types.ts";
import { BLOCKED_PRODUCTS } from "./util.ts";
import { decideCamProduct, fingerprintFeed, fingerprintWebcam } from "./fingerprint.ts";

// ── Unified `cams` table ──────────────────────────────────────────────────────
// One table for every camera, whatever its source. `kind` discriminates:
//   'cam'    Shodan-discovered device   (id = 'ip:port', baked screenshot bytes)
//   'feed'   live-pointer feed          (id = slug, jpg/mjpeg/mp4/hls/link)
//   'stream' YouTube live stream        (id = video_id, baked thumbnail)
// `source` carries honest provenance ('shodan' | 'caltrans' | 'youtube' | ...);
// `feed_kind` how a row renders. Nullable everywhere except the identity/lifecycle
// spine, so one row shape holds all three (unset columns just read NULL). `ss_hash`
// is a sha256 hex across all sources. Geo is one lat/lng pair for everyone.
const CAMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cams (
	id            TEXT    NOT NULL PRIMARY KEY,   -- 'ip:port' (cam) | slug (feed) | video_id (stream)
	kind          TEXT    NOT NULL,               -- 'cam' | 'feed' | 'stream'
	source        TEXT,                           -- provenance: 'shodan' | 'caltrans' | 'youtube' | ...
	feed_kind     TEXT    NOT NULL,               -- 'screenshot' | 'jpg' | 'mjpeg' | 'mp4' | 'hls' | 'youtube' | 'link'
	name          TEXT,                           -- display name (cam: host -> product -> ip)
	product       TEXT,                           -- device fingerprint (see fingerprint.ts)
	ip_str        TEXT,                           -- cam only
	port          INTEGER,                        -- cam only
	lat           REAL,
	lng           REAL,
	city          TEXT,
	country_code  TEXT,
	country_name  TEXT,
	region_code   TEXT,
	ss_mime       TEXT,
	ss_hash       TEXT,                           -- sha256 hex of the image bytes (change detection)
	ss_base64     TEXT,                           -- baked screenshot/thumbnail, no "data:" prefix
	live_url      TEXT,                           -- feed/stream: embed or watch URL
	external_url  TEXT,                           -- feed: optional human-facing viewer page
	shodan_id     TEXT,                           -- cam: per-banner UUID
	hostnames     TEXT,                           -- cam: JSON array
	domains       TEXT,                           -- cam: JSON array
	org           TEXT,
	isp           TEXT,
	asn           TEXT,
	observed_at   TEXT,                           -- cam: Shodan observation time
	label         TEXT,                           -- stream: curated youtube.md title
	title         TEXT,                           -- stream: snippet.title
	description   TEXT,                           -- stream: snippet.description
	channel_id    TEXT,                           -- stream: grouping key for siblings
	channel_title TEXT,
	published_at  TEXT,                           -- stream: snippet.publishedAt
	live_content  TEXT,                           -- stream: live | upcoming | none
	scheduled_start TEXT,
	actual_start  TEXT,
	thumbnail_url TEXT,                           -- stream: the snippet.thumbnails url fetched
	raw_json      TEXT    NOT NULL,               -- full source record minus image bytes
	first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
	last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
	preferred     INTEGER NOT NULL DEFAULT 0      -- cam only: 1 = pinned card image (see setPreferred)
) STRICT;
`;

/**
 * Insert columns per source, in order. Each source writes only its own subset
 * (unlisted columns read back NULL). `id` is the conflict key; columns omitted
 * from a list survive a re-ingest by design:
 *   - `first_seen`/`last_seen`/`preferred` are never listed (managed by the upsert).
 *   - CAM omits `preferred` so a reorder pin survives re-scrape.
 *   - FEED omits `product` so it is never overwritten by the upsert; the fingerprint hook
 *     writes it via a separate UPDATE only when the URL matches a rule, so a derived (or
 *     curated) product survives a re-ingest that matches nothing.
 *   - STREAM omits `lat`/`lng` so hand-assigned coords (bun run geo) survive.
 */
const CAM_COLUMNS = [
	"id", "kind", "source", "feed_kind", "name", "product", "ip_str", "port",
	"lat", "lng", "city", "country_code", "country_name", "region_code",
	"ss_mime", "ss_hash", "ss_base64", "shodan_id", "hostnames", "domains",
	"org", "isp", "asn", "observed_at", "raw_json",
] as const;

const FEED_COLUMNS = [
	"id", "kind", "source", "feed_kind", "name", "city", "country_name",
	"lat", "lng", "live_url", "external_url",
	"ss_mime", "ss_hash", "ss_base64", "raw_json",
] as const;

const STREAM_COLUMNS = [
	"id", "kind", "source", "feed_kind", "name", "live_url",
	"label", "title", "description", "channel_id", "channel_title",
	"published_at", "live_content", "scheduled_start", "actual_start", "thumbnail_url",
	"ss_mime", "ss_hash", "ss_base64", "raw_json",
] as const;

/** Blocked IPs we never want to ingest again. Keyed on IP only (every port). */
const BLACKLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS blacklist (
	ip_str    TEXT NOT NULL PRIMARY KEY,
	added_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * Hostnames/domains we never want to ingest, keyed on a registrable host stored
 * lowercase with no trailing dot. A listed host matches itself and any subdomain
 * (see hostBlocked), so `cloudzy.com` blocks `cam.node.cloudzy.com` too.
 */
const HOST_BLACKLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS host_blacklist (
	host      TEXT NOT NULL PRIMARY KEY,
	added_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * Hostnames/domains used to seed the host blacklist on a fresh database. Applied
 * only when the table is empty (see seedHostBlacklist), so hand-removed entries
 * never come back. Only hostnames are seeded; add IPs with `bun run blacklist <ip>`.
 */
const HOST_BLACKLIST_SEED: readonly string[] = [
	"cloudzy.com",
	"had.pm",
	"northstate.net",
];

/**
 * Unified metadata across every source: free-form tags and homepage-feature pins,
 * one polymorphic table keyed on (kind, ref, type, value). `kind` matches the cam's
 * kind ('cam' | 'stream' | 'feed'); `ref` is that source's key: 'cam' -> ip_str
 * (host-level, shared across a host's ports), 'stream' -> video_id, 'feed' -> feed id.
 * `type` is 'tag' (value = the normalized tag) or 'featured' (value = '', presence-only).
 * Seeded-then-curated: a fresh DB is seeded from IP_TAGS_SEED / FEATURED_SEED once.
 */
const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	kind      TEXT NOT NULL,             -- 'cam' | 'stream' | 'feed'
	ref       TEXT NOT NULL,             -- cam: ip_str (host-level) | stream: video_id | feed: id
	type      TEXT NOT NULL,             -- 'tag' | 'featured'
	value     TEXT NOT NULL DEFAULT '',  -- tag text; '' for featured
	added_at  TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (kind, ref, type, value)
) STRICT;
`;

/**
 * Fingerprint audit table: one row per fingerprinted cam/feed recording which signal
 * (method) at what confidence (tier) named which vendor, with the matched string
 * (evidence). Written at ingest by the cam/feed upserters (see makeInserter /
 * makeFeedInserter) and rebuilt wholesale by the catch-up backfill (src/fingerprint-cli.ts).
 * The site reads only kind/ref/vendor (loadVendorRefs → the per-vendor galleries); the
 * derived product itself lives on cams.product. `ref` equals cams.id.
 */
const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fingerprints (
	kind      TEXT NOT NULL,   -- 'cam' | 'feed'
	ref       TEXT NOT NULL,   -- cams.id: 'ip:port' for cams, feed id for feeds
	tier      TEXT,
	method    TEXT,
	vendor    TEXT,
	evidence  TEXT,
	PRIMARY KEY (kind, ref)
) STRICT;
`;

/** Which source a tag/featured `ref` points at. Matches the cam's `kind`. */
export type TagKind = "cam" | "stream" | "feed";

/** Which source a featured pin points at. Matches the cam's `kind`. */
export type FeaturedKind = "cam" | "stream" | "feed";

/**
 * Tag -> IPs used to seed the `meta` table (as kind='cam', type='tag') on a fresh
 * database. Applied only when no tag rows exist (see seedTags), so a tag removed by
 * hand never comes back. Tags are normalized on insert, so casing here is cosmetic.
 */
const IP_TAGS_SEED: Readonly<Record<string, readonly string[]>> = {
	graffiti: [
		"149.232.133.220",
		"149.232.137.67",
		"46.250.173.71",
		"46.250.171.73",
		"46.250.173.83",
		"181.2.201.255",
		"46.250.171.180",
		"149.232.135.7",
		"46.250.169.102",
	],
	games: [
		"24.136.120.51",
		"24.136.120.52",
		"202.39.216.179",
		"87.138.95.183",
	],
	backrooms: [
		"5.26.172.20",
		"220.134.169.248",
		"82.166.212.224",
		"84.120.199.77",
	],
};

/**
 * Homepage seed applied to `meta` (type='featured') on a fresh database. Like the
 * other seeds it runs only when no featured rows exist (see seedFeatured), so a pin
 * re-pointed by hand (or via `bun run feature`) never reverts.
 */
const FEATURED_SEED: readonly { kind: FeaturedKind; ref: string }[] = [
	{ kind: "cam", ref: "149.232.130.7" },
	{ kind: "cam", ref: "160.72.56.179" },
	{ kind: "stream", ref: "Yw8CZCEOdXE" },
	{ kind: "stream", ref: "UNbOvsRAx9U" },
];

export function openDb(path = DB_PATH): Database {
	const db = new Database(path, { create: true, strict: true });
	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA busy_timeout = 5000;");
	db.run(CAMS_SCHEMA);
	db.run(META_SCHEMA);
	db.run(AUDIT_SCHEMA);
	db.run(BLACKLIST_SCHEMA);
	db.run(HOST_BLACKLIST_SCHEMA);
	seedHostBlacklist(db);
	seedTags(db);
	seedFeatured(db);
	return db;
}

/** Checkpoint the WAL back into the main file (macOS keeps -wal/-shm otherwise) and close. */
export function closeDb(db: Database): void {
	try {
		db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
		db.run("PRAGMA wal_checkpoint(TRUNCATE);");
	} catch {}
	db.close();
}

// ── Upsert ──────────────────────────────────────────────────────────────────

/** Tally of what a bulk upsert did: brand-new rows, refreshed rows, and how many refreshes carried a new screenshot. */
export interface InsertResult {
	/** Rows whose `id` was not previously stored. */
	added: number;
	/** Rows that already existed and were overwritten with newer data. */
	updated: number;
	/** Subset of `updated` whose screenshot hash changed (genuinely new image). */
	changed: number;
}

/** A row bound for `cams`: it always carries the conflict key and screenshot hash. */
type UpsertRow = { id: string; ss_hash: string | null } & Record<string, string | number | null>;

/**
 * Build a transactional bulk upserter for `cams`, scoped to one source's column
 * set. Inserts new `id` rows and refreshes existing ones (screenshot + metadata +
 * last_seen), preserving the original first_seen and any column omitted from
 * `columns` (preferred/product/coords by source; see the *_COLUMNS notes). Returns
 * a tally of added / updated / changed rows.
 */
/** The baked-image columns, kept together: a snapshot either sets all three or none. */
const IMAGE_COLS = new Set(["ss_mime", "ss_hash", "ss_base64"]);

/**
 * last_seen sentinel marking a hand-set thumbnail (see setThumbnail) that a re-scan must
 * never overwrite. A valid, maximal datetime string no `datetime('now')` write can produce;
 * the upserter below preserves both the image and this sentinel on conflict.
 */
export const SS_PERMANENT = "9999-12-31 23:59:59";

/** The pre-upsert snapshot of a row, handed to `afterUpsert` so it can decide against the
 *  stored state (the prior product is the linchpin of the fingerprint anti-downgrade). */
interface PriorRow {
	h: string | null;
	ls: string;
	product: string | null;
}

/**
 * Optional per-source ingest hook. `afterUpsert` runs synchronously INSIDE the transaction,
 * right after `stmt.run(row)`, once per row, with the pre-upsert snapshot (`before`, null for
 * a brand-new row) and the just-written `row`. Cams/feeds use it to derive `product` + write
 * the `fingerprints` audit row at insert. It MUST stay synchronous — no Promise, no nested
 * `db.transaction` — since the surrounding `db.transaction` commits when its callback returns.
 */
interface UpsertOpts {
	afterUpsert?: (before: PriorRow | null, row: UpsertRow) => void;
}

function makeUpserter(db: Database, columns: readonly string[], opts: UpsertOpts = {}): (rows: UpsertRow[]) => InsertResult {
	const placeholders = columns.map((c) => `$${c}`).join(", ");
	// G5: never overwrite a stored image with a blank. On a refresh whose snapshot
	// failed (a dead feed, or — the case that bit us — a rate-limited re-grab), the
	// image columns come in NULL; COALESCE keeps the last good screenshot instead of
	// wiping the card. A successful grab (non-NULL) still replaces it. Metadata columns
	// always take the fresh value.
	// Permanence: a row whose last_seen equals SS_PERMANENT (a hand-set thumbnail marked
	// permanent in the dev tool) keeps BOTH its image and the sentinel on conflict, so a
	// re-scan refreshes only its metadata. `last_seen` in these CASEs is the pre-update
	// (existing) row value (every SET expression in ON CONFLICT DO UPDATE reads the original
	// row), so assignment order is irrelevant. SS_PERMANENT is a fixed constant, not input.
	const lock = `last_seen = '${SS_PERMANENT}'`;
	const updates = columns
		.filter((c) => c !== "id")
		.map((c) =>
			IMAGE_COLS.has(c)
				? `${c} = CASE WHEN ${lock} THEN ${c} ELSE COALESCE(excluded.${c}, ${c}) END`
				: `${c} = excluded.${c}`,
		)
		.join(", ");
	const stmt = db.query(
		`INSERT INTO cams (${columns.join(", ")}, last_seen)
		 VALUES (${placeholders}, datetime('now'))
		 ON CONFLICT(id) DO UPDATE SET ${updates},
		   last_seen = CASE WHEN ${lock} THEN last_seen ELSE excluded.last_seen END`,
	);
	// ON CONFLICT DO UPDATE reports changes>0 for both inserts and updates, so we
	// can't infer "new" from changes. Peek at the prior screenshot hash instead. We
	// also read last_seen so a locked (permanent) row isn't miscounted as "changed",
	// and the prior product so the fingerprint hook can decide against the stored value.
	const prior = db.query("SELECT ss_hash AS h, last_seen AS ls, product AS product FROM cams WHERE id = ?");
	const { afterUpsert } = opts;
	return db.transaction((rows: UpsertRow[]): InsertResult => {
		let added = 0;
		let updated = 0;
		let changed = 0;
		for (const row of rows) {
			const before = prior.get(row.id) as PriorRow | null;
			stmt.run(row);
			// Fingerprint the row against its pre-upsert state (synchronous; runs in this txn).
			afterUpsert?.(before, row);
			if (before == null) {
				added++;
			} else {
				updated++;
				// Only a real, non-null new image that differs counts as "changed". A failed
				// re-grab is preserved by COALESCE, and a permanent row's image by the lock,
				// so neither counts here.
				if (row.ss_hash != null && before.h !== row.ss_hash && before.ls !== SS_PERMANENT) changed++;
			}
		}
		return { added, updated, changed };
	});
}

/** Prepared statements the fingerprint hooks share: correct `product`, then record the audit row. */
function fingerprintWriters(db: Database): { setProduct: ReturnType<Database["query"]>; recordFp: ReturnType<Database["query"]> } {
	return {
		setProduct: db.query("UPDATE cams SET product = ? WHERE id = ?"),
		recordFp: db.query(
			"INSERT OR REPLACE INTO fingerprints (kind, ref, tier, method, vendor, evidence) VALUES (?, ?, ?, ?, ?, ?)",
		),
	};
}

/**
 * Bulk upserter for Shodan cam rows (kind='cam'). Fingerprints each row at insert: the cascade
 * runs on the banner, decideCamProduct reconciles it against the prior stored product (empty or
 * server-name → re-derive; a real product upgrades only on a safe hit; an unidentified target
 * floors to "Generic IP camera"), and both cams.product and the fingerprints audit row are written
 * in the same transaction. A brand-new row's "old" is the raw Shodan product toRow seeded; a
 * re-ingest's is the previously-decided value, so a weaker re-scrape can't downgrade a good label.
 */
export function makeInserter(db: Database): (rows: CamRow[]) => InsertResult {
	const { setProduct, recordFp } = fingerprintWriters(db);
	return makeUpserter(db, CAM_COLUMNS, {
		afterUpsert(before, row) {
			const oldProduct = before?.product ?? ((row.product as string | null) ?? null);
			const d = decideCamProduct(oldProduct, fingerprintWebcam(row.raw_json as string));
			setProduct.run(d.product, row.id);
			recordFp.run("cam", row.id, d.tier === "-" ? null : d.tier, d.method, d.vendor === "-" ? null : d.vendor, d.evidence || null);
		},
	});
}

/** Bulk upserter for YouTube stream rows (kind='stream'). No fingerprinting (streams carry none). */
export function makeYtInserter(db: Database): (rows: YtRow[]) => InsertResult {
	return makeUpserter(db, STREAM_COLUMNS);
}

/**
 * Bulk upserter for feed rows (kind='feed'). `FEED_COLUMNS` deliberately omits `product` (so the
 * upsert never touches it); the hook writes product only when the live URL matches a fingerprint
 * rule, mirroring the CLI — an operator-network feed with no match keeps whatever product it had,
 * preserving the survives-re-ingest invariant.
 */
export function makeFeedInserter(db: Database): (rows: FeedRow[]) => InsertResult {
	const { setProduct, recordFp } = fingerprintWriters(db);
	return makeUpserter(db, FEED_COLUMNS, {
		afterUpsert(_before, row) {
			const fp = fingerprintFeed({ live_url: row.live_url as string | null, source: row.source as string | null });
			if (!fp) return;
			setProduct.run(fp.product, row.id);
			recordFp.run("feed", row.id, fp.tier, fp.method, fp.vendor, fp.evidence || null);
		},
	});
}

// ── Counts + readers (one per kind) ──────────────────────────────────────────

function countKind(db: Database, kind: TagKind): number {
	return (db.query("SELECT COUNT(*) AS c FROM cams WHERE kind = ?").get(kind) as { c: number }).c;
}

export function countRows(db: Database): number {
	return countKind(db, "cam");
}

export function countYtRows(db: Database): number {
	return countKind(db, "stream");
}

export function countFeedRows(db: Database): number {
	return countKind(db, "feed");
}

/** Every Shodan cam row, ordered (country, ip, port) so a host's ports stay adjacent. */
export function allRows(db: Database): StoredRow[] {
	return db
		.query("SELECT * FROM cams WHERE kind = 'cam' ORDER BY country_name, ip_str, port")
		.all() as StoredRow[];
}

/**
 * Every stream row, ordered so live streams sort first and streams sharing a
 * channel stay adjacent (then newest-first within a channel). The renderer does
 * the channel grouping for detail-page siblings; the gallery never collapses
 * rows, so this order is exactly the card order.
 */
export function allYtRows(db: Database): StoredYtRow[] {
	return db
		.query(
			`SELECT * FROM cams WHERE kind = 'stream'
			 ORDER BY
				 CASE live_content WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
				 channel_title,
				 published_at DESC,
				 id`,
		)
		.all() as StoredYtRow[];
}

/**
 * Every feed row. Cams with a baked thumbnail sort first so the gallery leads with
 * working previews; within each group, ordered by country then source then name for
 * a stable, browsable order. The gallery never groups rows (one card per cam), so
 * this order is exactly the card order.
 */
export function allFeedRows(db: Database): StoredFeedRow[] {
	return db
		.query("SELECT * FROM cams WHERE kind = 'feed' ORDER BY (ss_base64 IS NULL), country_name, source, name, id")
		.all() as StoredFeedRow[];
}

// ── Metadata-only readers (for `bun dev --index-only`) ─────────────────────────
// These mirror the readers above but never transfer the screenshot payload, which is
// ~99% of the DB. `bun dev --index-only` only re-renders the homepage and pulls the ~12
// shown cards' images from the on-disk manifest, so it needs row metadata (timestamps,
// ids, labels) but not ss_base64. The `ss_base64` column is replaced by a truthy '1'
// sentinel when non-null so the thumbnail-first sorts keep working unchanged.

/** Column list for the `cams` table minus `ss_base64`, plus the presence sentinel. Built
 *  once from the live schema so a column added to CAMS_SCHEMA is picked up automatically. */
function metaSelect(db: Database): string {
	const cols = (db.query("PRAGMA table_info(cams)").all() as { name: string }[])
		.map((c) => c.name)
		.filter((c) => c !== "ss_base64")
		.map((c) => `"${c}"`);
	cols.push("CASE WHEN ss_base64 IS NOT NULL THEN '1' END AS ss_base64");
	return cols.join(", ");
}

/** `allRows` without the screenshot bytes. */
export function allRowsMeta(db: Database): StoredRow[] {
	return db
		.query(`SELECT ${metaSelect(db)} FROM cams WHERE kind = 'cam' ORDER BY country_name, ip_str, port`)
		.all() as StoredRow[];
}

/** `allYtRows` without the screenshot bytes. */
export function allYtRowsMeta(db: Database): StoredYtRow[] {
	return db
		.query(
			`SELECT ${metaSelect(db)} FROM cams WHERE kind = 'stream'
			 ORDER BY
				 CASE live_content WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
				 channel_title,
				 published_at DESC,
				 id`,
		)
		.all() as StoredYtRow[];
}

/** `allFeedRows` without the screenshot bytes (the sentinel keeps the thumbnail-first sort). */
export function allFeedRowsMeta(db: Database): StoredFeedRow[] {
	return db
		.query(`SELECT ${metaSelect(db)} FROM cams WHERE kind = 'feed' ORDER BY (ss_base64 IS NULL), country_name, source, name, id`)
		.all() as StoredFeedRow[];
}

/** True when any stored cam has this exact IP (any port). */
export function hasHost(db: Database, ip: string): boolean {
	return db.query("SELECT 1 FROM cams WHERE kind = 'cam' AND ip_str = ? LIMIT 1").get(ip) != null;
}

/** True when a stream with this exact video_id is stored. Companion to hasHost. */
export function hasStream(db: Database, videoId: string): boolean {
	return db.query("SELECT 1 FROM cams WHERE kind = 'stream' AND id = ? LIMIT 1").get(videoId) != null;
}

/** True when a feed cam with this exact id is stored. Companion to hasHost / hasStream. */
export function hasFeed(db: Database, id: string): boolean {
	return db.query("SELECT 1 FROM cams WHERE kind = 'feed' AND id = ? LIMIT 1").get(id) != null;
}

/**
 * Of the given feed ids, which already have a non-null thumbnail stored. Feeds the HLS
 * importer's `--skip-existing`: already-grabbed cams are skipped so a per-IP re-run spends
 * its limited request budget only on the gaps. A null-thumbnail placeholder row (a blocked
 * or dead stream) is deliberately NOT counted as done, so those are retried. Chunked to
 * stay under SQLite's bound-variable limit.
 */
export function feedThumbIds(db: Database, ids: string[]): Set<string> {
	const have = new Set<string>();
	const CHUNK = 900;
	for (let i = 0; i < ids.length; i += CHUNK) {
		const slice = ids.slice(i, i + CHUNK);
		const placeholders = slice.map(() => "?").join(", ");
		const rows = db
			.query(`SELECT id FROM cams WHERE kind = 'feed' AND ss_base64 IS NOT NULL AND id IN (${placeholders})`)
			.all(...slice) as { id: string }[];
		for (const r of rows) have.add(r.id);
	}
	return have;
}

/**
 * Purge stored cams whose product we filter at ingestion (RDP/VNC). The ingestion
 * guard (isBlockedProduct) only blocks *new* rows, so this retroactively removes any
 * that predate it. Cam-source only. Returns the number of rows removed.
 */
export function deleteBlockedProducts(db: Database): number {
	const list = [...BLOCKED_PRODUCTS];
	if (list.length === 0) return 0;
	const placeholders = list.map(() => "?").join(", ");
	return db
		.query(`DELETE FROM cams WHERE kind = 'cam' AND lower(trim(product)) IN (${placeholders})`)
		.run(...list).changes;
}

// ── Metadata (tags + featured, one `meta` table) ──────────────────────────────

/**
 * Seed host_blacklist with HOST_BLACKLIST_SEED, but only on a fresh (empty) table.
 * Idempotent: once the table holds any row this is a no-op, so it never brings back
 * an entry that was later removed by hand.
 */
export function seedHostBlacklist(db: Database): void {
	const { c } = db.query("SELECT COUNT(*) AS c FROM host_blacklist").get() as { c: number };
	if (c > 0) return;
	const stmt = db.query("INSERT OR IGNORE INTO host_blacklist (host) VALUES (?)");
	db.transaction((hosts: readonly string[]) => {
		for (const h of hosts) stmt.run(normalizeHost(h));
	})(HOST_BLACKLIST_SEED);
}

/** Canonical host key: trimmed, lowercased, trailing FQDN dot removed. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Canonical tag key: trimmed and lowercased, so casing/whitespace never dupes a tag. */
export function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase();
}

/**
 * Seed `meta` tags from IP_TAGS_SEED (all cams) when no tag rows exist. Idempotent:
 * once any tag exists this is a no-op, so it never re-adds a tag removed by hand.
 */
export function seedTags(db: Database): void {
	const { c } = db.query("SELECT COUNT(*) AS c FROM meta WHERE type = 'tag'").get() as { c: number };
	if (c > 0) return;
	const stmt = db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES ('cam', ?, 'tag', ?)");
	db.transaction((seed: Readonly<Record<string, readonly string[]>>) => {
		for (const [tag, ips] of Object.entries(seed)) {
			const t = normalizeTag(tag);
			for (const ip of ips) stmt.run(ip.trim(), t);
		}
	})(IP_TAGS_SEED);
}

/**
 * Every tagged ref of one kind as a map of ref -> tag list, loaded once for a build.
 * Refs with no tags are absent (callers default a miss to []). Tags come back sorted
 * so the comma-joined display on a detail page is stable.
 */
export function loadTags(db: Database, kind: TagKind): Map<string, string[]> {
	const rows = db
		.query("SELECT ref, value FROM meta WHERE kind = ? AND type = 'tag' ORDER BY ref, value")
		.all(kind) as { ref: string; value: string }[];
	const map = new Map<string, string[]>();
	for (const r of rows) {
		const list = map.get(r.ref);
		if (list) list.push(r.value);
		else map.set(r.ref, [r.value]);
	}
	return map;
}

/**
 * Every tag mapped to the entities that carry it (tag -> [{kind, ref}]), loaded once
 * for the browse-by-tag build. Ordered by tag, then kind, then ref (so 'cam' sorts
 * before 'feed' before 'stream'). The build resolves each ref against its in-memory
 * view models and skips any whose row is gone (see build.ts).
 */
export function loadTagIndex(db: Database): Map<string, { kind: TagKind; ref: string }[]> {
	const rows = db
		.query("SELECT kind, ref, value FROM meta WHERE type = 'tag' ORDER BY value, kind, ref")
		.all() as { kind: TagKind; ref: string; value: string }[];
	const map = new Map<string, { kind: TagKind; ref: string }[]>();
	for (const r of rows) {
		const entry = { kind: r.kind, ref: r.ref };
		const list = map.get(r.value);
		if (list) list.push(entry);
		else map.set(r.value, [entry]);
	}
	return map;
}

/**
 * Add a single tag to an entity, normalized (see normalizeTag). `kind` selects the
 * source and `ref` is that source's key (ip_str / video_id / feed id). Returns true
 * if newly added, false if the entity already carried that tag (or it normalizes to empty).
 */
export function addTag(db: Database, kind: TagKind, ref: string, tag: string): boolean {
	const t = normalizeTag(tag);
	if (t === "") return false;
	return db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES (?, ?, 'tag', ?)").run(kind, ref, t).changes > 0;
}

/**
 * Remove a single tag from an entity, normalized to match how it was stored. Returns
 * true if a row was deleted, false if the entity did not carry that tag. Inverse of addTag.
 */
export function removeTag(db: Database, kind: TagKind, ref: string, tag: string): boolean {
	const t = normalizeTag(tag);
	if (t === "") return false;
	return db.query("DELETE FROM meta WHERE kind = ? AND ref = ? AND type = 'tag' AND value = ?").run(kind, ref, t).changes > 0;
}

/** Every tag on one entity, sorted. Feeds the dev-mode tag manager's removable chips. */
export function entityTags(db: Database, kind: TagKind, ref: string): string[] {
	return (db.query("SELECT value FROM meta WHERE kind = ? AND ref = ? AND type = 'tag' ORDER BY value").all(kind, ref) as { value: string }[])
		.map((r) => r.value);
}

/** Every distinct tag name across all kinds, sorted. Feeds the dev-mode tag autocomplete. */
export function distinctTags(db: Database): string[] {
	return (db.query("SELECT DISTINCT value FROM meta WHERE type = 'tag' ORDER BY value").all() as { value: string }[])
		.map((r) => r.value);
}

/**
 * Every distinct tag with how many entities carry it, ordered by tag name. Since a
 * tag can't repeat on one entity, COUNT(*) per tag is exactly its entity count across
 * all sources. Counts every tagged ref whether or not its row still exists. Feeds renderTagsMain.
 */
export function loadTagCounts(db: Database): { tag: string; count: number }[] {
	return db
		.query("SELECT value AS tag, COUNT(*) AS count FROM meta WHERE type = 'tag' GROUP BY value ORDER BY value")
		.all() as { tag: string; count: number }[];
}

/**
 * Seed `meta` featured pins from FEATURED_SEED when no featured rows exist.
 * Idempotent: once any featured row exists this is a no-op, so hand-featured entries
 * never revert.
 */
export function seedFeatured(db: Database): void {
	const { c } = db.query("SELECT COUNT(*) AS c FROM meta WHERE type = 'featured'").get() as { c: number };
	if (c > 0) return;
	const stmt = db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES (?, ?, 'featured', '')");
	db.transaction((seed: readonly { kind: FeaturedKind; ref: string }[]) => {
		for (const s of seed) stmt.run(s.kind, s.ref);
	})(FEATURED_SEED);
}

/**
 * The homepage's candidate featured refs, split by kind: `cams` holds ip_strs,
 * `streams` holds video_ids, `feeds` holds feed ids. Order is not meaningful (the build
 * samples at random); the build resolves each ref against the current rows and skips any
 * whose row is gone.
 */
export function loadFeatured(db: Database): { cams: string[]; streams: string[]; feeds: string[] } {
	const rows = db
		.query("SELECT kind, ref FROM meta WHERE type = 'featured' ORDER BY kind, added_at, ref")
		.all() as { kind: string; ref: string }[];
	const cams: string[] = [];
	const streams: string[] = [];
	const feeds: string[] = [];
	for (const r of rows) {
		if (r.kind === "cam") cams.push(r.ref);
		else if (r.kind === "stream") streams.push(r.ref);
		else if (r.kind === "feed") feeds.push(r.ref);
	}
	return { cams, streams, feeds };
}

/** Mark (kind, ref) as featured. Idempotent (INSERT OR IGNORE); true if newly added. */
export function addFeatured(db: Database, kind: FeaturedKind, ref: string): boolean {
	return db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES (?, ?, 'featured', '')").run(kind, ref).changes > 0;
}

/** Un-feature (kind, ref). True if a row was deleted, false if it was not featured. */
export function removeFeatured(db: Database, kind: FeaturedKind, ref: string): boolean {
	return db.query("DELETE FROM meta WHERE kind = ? AND ref = ? AND type = 'featured'").run(kind, ref).changes > 0;
}

/** True when (kind, ref) is currently featured. */
export function isFeatured(db: Database, kind: FeaturedKind, ref: string): boolean {
	return db.query("SELECT 1 FROM meta WHERE kind = ? AND ref = ? AND type = 'featured' LIMIT 1").get(kind, ref) != null;
}

// ── Stream geo (manual coordinates, kept inline on the cam row) ────────────────

/**
 * Every stream's coordinates as a map of video_id -> {lat, lng}, loaded once for a
 * build. Streams with no assigned coord are absent (the build gives them no map dot).
 * Companion to loadTags. YouTube publishes no location, so these are hand-assigned
 * (see setYtGeo / `bun run geo`), stored inline on the stream's `cams` row.
 */
export function loadYtGeo(db: Database): Map<string, { lat: number; lng: number }> {
	const rows = db
		.query("SELECT id, lat, lng FROM cams WHERE kind = 'stream' AND lat IS NOT NULL AND lng IS NOT NULL")
		.all() as { id: string; lat: number; lng: number }[];
	const map = new Map<string, { lat: number; lng: number }>();
	for (const r of rows) map.set(r.id, { lat: r.lat, lng: r.lng });
	return map;
}

/** Set (or replace) a stream's coordinates inline on its `cams` row. No-op if the stream isn't stored. */
export function setYtGeo(db: Database, videoId: string, lat: number, lng: number): void {
	db.query("UPDATE cams SET lat = ?, lng = ? WHERE kind = 'stream' AND id = ?").run(lat, lng, videoId);
}

// ── Fingerprint vendor index (per-vendor galleries) ────────────────────────────

/**
 * Per-vendor camera refs from the fingerprints audit table, feeding the vendor galleries
 * and the fingerprints breakdown's per-make "filter" links. Returns two views of the same
 * rows: `byVendor` (vendor -> { hosts, feeds }, cam refs deduped to host `ip_str` since
 * cards are per-host, feed refs the `cams.id` directly) and `byRef` (cams.id -> vendor,
 * for tagging each product occurrence in the breakdown with its vendor). NULL-vendor rows
 * are skipped; streams carry no fingerprints.
 *
 * The table is created by openDb() and populated at ingest (and rebuilt by the catch-up
 * backfill), so it normally exists. The guard stays for safety — a DB opened by some other
 * path, or one that has ingested nothing yet, simply yields no vendor galleries rather than
 * throwing the build.
 */
export function loadVendorRefs(db: Database): {
	byVendor: Map<string, { hosts: Set<string>; feeds: Set<string> }>;
	byRef: Map<string, string>;
} {
	const byVendor = new Map<string, { hosts: Set<string>; feeds: Set<string> }>();
	const byRef = new Map<string, string>();
	const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fingerprints' LIMIT 1").get();
	if (!exists) return { byVendor, byRef };
	const rows = db
		.query("SELECT kind, ref, vendor FROM fingerprints WHERE vendor IS NOT NULL")
		.all() as { kind: string; ref: string; vendor: string }[];
	for (const r of rows) {
		byRef.set(r.ref, r.vendor);
		const g = byVendor.get(r.vendor) ?? { hosts: new Set<string>(), feeds: new Set<string>() };
		if (r.kind === "cam") {
			// ref is 'ip:port'; dedupe to the host ip_str (port is after the last colon).
			const i = r.ref.lastIndexOf(":");
			g.hosts.add(i === -1 ? r.ref : r.ref.slice(0, i));
		} else if (r.kind === "feed") {
			g.feeds.add(r.ref);
		}
		byVendor.set(r.vendor, g);
	}
	return { byVendor, byRef };
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

/** True when `name` equals, or is a subdomain of, any listed host. Case/dot-insensitive. */
function hostBlocked(name: string, hosts: Set<string>): boolean {
	const n = normalizeHost(name);
	if (!n) return false;
	for (const bad of hosts) {
		if (n === bad || n.endsWith(`.${bad}`)) return true;
	}
	return false;
}

/** Parse a stored JSON string array, tolerating malformed values (returns []). */
function parseHostArray(json: string): string[] {
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** Blacklist state loaded once per run, with an O(1)-ish membership check for ingestion. */
export interface Blacklist {
	ips: Set<string>;
	hosts: Set<string>;
	/** True when a match should be skipped: its IP, or any hostname/domain, is listed. */
	blocks(m: WebcamMatch): boolean;
}

/** Load both blacklists (IPs and hostnames) into an object that can vet a match. */
export function loadBlacklist(db: Database): Blacklist {
	const ipRows = db.query("SELECT ip_str FROM blacklist").all() as { ip_str: string }[];
	const hostRows = db.query("SELECT host FROM host_blacklist").all() as { host: string }[];
	const ips = new Set(ipRows.map((r) => r.ip_str));
	const hosts = new Set(hostRows.map((r) => r.host));
	return {
		ips,
		hosts,
		blocks(m: WebcamMatch): boolean {
			if (m.ip_str && ips.has(m.ip_str)) return true;
			if (hosts.size === 0) return false;
			for (const h of m.hostnames ?? []) if (hostBlocked(h, hosts)) return true;
			for (const d of m.domains ?? []) if (hostBlocked(d, hosts)) return true;
			return false;
		},
	};
}

/** Add an IP to the blacklist. Returns true if newly added, false if already present. */
export function blacklist(db: Database, ip: string): boolean {
	return db.query("INSERT OR IGNORE INTO blacklist (ip_str) VALUES (?)").run(ip).changes > 0;
}

/** Remove an IP from the blacklist. Returns true if it was listed, false if not present. */
export function unblacklist(db: Database, ip: string): boolean {
	return db.query("DELETE FROM blacklist WHERE ip_str = ?").run(ip).changes > 0;
}

/** Add a hostname to the blacklist. Returns true if newly added, false if already present. */
export function blacklistHost(db: Database, host: string): boolean {
	return db.query("INSERT OR IGNORE INTO host_blacklist (host) VALUES (?)")
		.run(normalizeHost(host)).changes > 0;
}

/** Remove a hostname from the blacklist. Returns true if it was listed, false if not present. */
export function unblacklistHost(db: Database, host: string): boolean {
	return db.query("DELETE FROM host_blacklist WHERE host = ?").run(normalizeHost(host)).changes > 0;
}

/**
 * Delete every stored cam whose hostnames or domains match `host` (itself or a
 * subdomain). SQLite can't suffix-match inside the JSON columns, so we scan cam rows
 * and reuse hostBlocked. Returns the number of cam rows removed and the distinct
 * `ip_str`s they belonged to (a host's ports share one ip_str), so a caller can act on
 * those hosts — e.g. clean their meta. Callers that only want the count use `.rows`.
 */
export function deleteWebcamsByHost(db: Database, host: string): { rows: number; ips: string[] } {
	const hosts = new Set([normalizeHost(host)]);
	const rows = db
		.query("SELECT id, ip_str, hostnames, domains FROM cams WHERE kind = 'cam'")
		.all() as { id: string; ip_str: string | null; hostnames: string | null; domains: string | null }[];
	const del = db.query("DELETE FROM cams WHERE id = ?");
	const delFp = db.query("DELETE FROM fingerprints WHERE kind = 'cam' AND ref = ?");
	return db.transaction(() => {
		let n = 0;
		const ips = new Set<string>();
		for (const r of rows) {
			const names = [...parseHostArray(r.hostnames ?? "[]"), ...parseHostArray(r.domains ?? "[]")];
			if (names.some((name) => hostBlocked(name, hosts))) {
				const c = del.run(r.id).changes;
				delFp.run(r.id); // ref === cams.id for a cam
				n += c;
				if (c && r.ip_str) ips.add(r.ip_str);
			}
		}
		return { rows: n, ips: [...ips] };
	})();
}

/**
 * Delete every stored cam for one IP (all ports) and its fingerprint audit rows. Returns cam
 * rows removed. No meta side effect. The fingerprints ref for a cam is 'ip:port', so an
 * `ip:%` LIKE clears all of the host's ports (the ':' after the IP prevents matching a longer IP).
 */
export function deleteWebcamsByIp(db: Database, ip: string): number {
	db.query("DELETE FROM fingerprints WHERE kind = 'cam' AND ref LIKE ?").run(`${ip}:%`);
	return db.query("DELETE FROM cams WHERE kind = 'cam' AND ip_str = ?").run(ip).changes;
}

/**
 * Delete an entity's tags/featured pins (its meta rows). `ref` is that kind's meta key:
 * ip_str (cam), video_id (stream), id (feed) — see META_SCHEMA.
 */
export function deleteEntityMeta(db: Database, kind: TagKind, ref: string): void {
	db.query("DELETE FROM meta WHERE kind = ? AND ref = ?").run(kind, ref);
}

/**
 * Remove one entity and its meta, WITHOUT blacklisting (so it returns on re-ingest). A cam
 * removes every port for the host (matched on ip_str); a stream/feed removes the single row
 * (matched on id). Returns the number of cam/stream/feed rows deleted.
 */
export function removeEntity(db: Database, kind: TagKind, ref: string): number {
	return db.transaction(() => {
		let changes: number;
		if (kind === "cam") {
			changes = deleteWebcamsByIp(db, ref); // also purges the host's fingerprint rows
		} else {
			// feed removes the single row (ref === cams.id); purge its fingerprint audit row too
			// (streams carry none, so the delete is a harmless no-op there).
			changes = db.query("DELETE FROM cams WHERE kind = ? AND id = ?").run(kind, ref).changes;
			db.query("DELETE FROM fingerprints WHERE kind = ? AND ref = ?").run(kind, ref);
		}
		deleteEntityMeta(db, kind, ref);
		return changes;
	})();
}

/**
 * Remove every cam matching `host` (itself or a subdomain) and each removed host's meta,
 * without blacklisting. The hostname counterpart to removeEntity's cam path. Returns the
 * number of cam rows removed.
 */
export function removeWebcamsByHost(db: Database, host: string): number {
	const { rows, ips } = deleteWebcamsByHost(db, host);
	for (const ip of ips) deleteEntityMeta(db, "cam", ip);
	return rows;
}

// ── Preferred screenshot (card image pin) ─────────────────────────────────────

/**
 * Pin (ip_str, port) as the row that represents this host on its gallery card,
 * clearing any prior pin on the same IP so at most one port is ever preferred.
 * Returns false (and changes nothing) if that (ip_str, port) is not stored.
 */
export function setPreferred(db: Database, ip: string, port: number): boolean {
	const id = `${ip}:${port}`;
	if (!db.query("SELECT 1 FROM cams WHERE kind = 'cam' AND id = ?").get(id)) return false;
	db.transaction(() => {
		db.query("UPDATE cams SET preferred = 0 WHERE kind = 'cam' AND ip_str = ?").run(ip);
		db.query("UPDATE cams SET preferred = 1 WHERE id = ?").run(id);
	})();
	return true;
}

/** Clear any pin on this IP (its card reverts to the newest screenshot). Returns true if one existed. */
export function clearPreferred(db: Database, ip: string): boolean {
	return db.query("UPDATE cams SET preferred = 0 WHERE kind = 'cam' AND ip_str = ? AND preferred = 1").run(ip).changes > 0;
}

/**
 * Replace one row's stored thumbnail (the ss_* columns) by primary-key id, stamping
 * last_seen so a later re-scan either MAY overwrite it (`permanent = false` -> datetime('now'),
 * which also clears any prior permanence) or must NOT (`permanent = true` -> the SS_PERMANENT
 * sentinel the upserter honors). Returns false if no row has that id. `hash` is the sha256
 * hex of the decoded image bytes, uniform with the ingest sources. `stamp` is a fixed
 * constant expression, never user input.
 */
export function setThumbnail(db: Database, id: string, mime: string, hash: string, base64: string, permanent: boolean): boolean {
	const stamp = permanent ? `'${SS_PERMANENT}'` : "datetime('now')";
	return db.query(`UPDATE cams SET ss_mime = ?, ss_hash = ?, ss_base64 = ?, last_seen = ${stamp} WHERE id = ?`).run(mime, hash, base64, id).changes > 0;
}
