import { Database, constants } from "bun:sqlite";
import { DB_PATH } from "../../core/config.ts";
import { normalizeHost, normalizeTag } from "./common.ts";

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
 * `type` is 'tag' (value = the normalized tag), 'featured' (value = '', presence-only), or
 * 'superfeature' (value = an event key grouping feeds for the homepage banner + /event page).
 * Seeded-then-curated: a fresh DB is seeded from IP_TAGS_SEED / FEATURED_SEED once.
 */
const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
	kind      TEXT NOT NULL,             -- 'cam' | 'stream' | 'feed'
	ref       TEXT NOT NULL,             -- cam: ip_str (host-level) | stream: video_id | feed: id
	type      TEXT NOT NULL,             -- 'tag' | 'featured' | 'superfeature'
	value     TEXT NOT NULL DEFAULT '',  -- tag text; '' for featured; event key for superfeature
	added_at  TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (kind, ref, type, value)
) STRICT;
`;

/**
 * Fingerprint audit table: one row per fingerprinted cam/feed recording which signal
 * (method) at what confidence (tier) named which vendor, with the matched string
 * (evidence). Written at ingest by the cam/feed upserters (see makeInserter /
 * makeFeedInserter) and rebuilt wholesale by the catch-up backfill (fingerprint/fingerprint-cli.ts).
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
const FEATURED_SEED: readonly { kind: TagKind; ref: string }[] = [
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

/**
 * Seed host_blacklist with HOST_BLACKLIST_SEED, but only on a fresh (empty) table.
 * Idempotent: once the table holds any row this is a no-op, so it never brings back
 * an entry that was later removed by hand.
 */
function seedHostBlacklist(db: Database): void {
	const { c } = db.query("SELECT COUNT(*) AS c FROM host_blacklist").get() as { c: number };
	if (c > 0) return;
	const stmt = db.query("INSERT OR IGNORE INTO host_blacklist (host) VALUES (?)");
	db.transaction((hosts: readonly string[]) => {
		for (const h of hosts) stmt.run(normalizeHost(h));
	})(HOST_BLACKLIST_SEED);
}

/**
 * Seed `meta` tags from IP_TAGS_SEED (all cams) when no tag rows exist. Idempotent:
 * once any tag exists this is a no-op, so it never re-adds a tag removed by hand.
 */
function seedTags(db: Database): void {
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
 * Seed `meta` featured pins from FEATURED_SEED when no featured rows exist.
 * Idempotent: once any featured row exists this is a no-op, so hand-featured entries
 * never revert.
 */
function seedFeatured(db: Database): void {
	const { c } = db.query("SELECT COUNT(*) AS c FROM meta WHERE type = 'featured'").get() as { c: number };
	if (c > 0) return;
	const stmt = db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES (?, ?, 'featured', '')");
	db.transaction((seed: readonly { kind: TagKind; ref: string }[]) => {
		for (const s of seed) stmt.run(s.kind, s.ref);
	})(FEATURED_SEED);
}
