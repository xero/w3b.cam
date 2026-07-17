import type { Database } from "bun:sqlite";
import type { CamRow, FeedRow, YtRow } from "../../core/types.ts";
import { decideCamProduct, fingerprintFeed, fingerprintWebcam } from "../../fingerprint/fingerprint.ts";
import { deriveHostFeed, isRtspHost } from "../../fingerprint/host-feed.ts";
import { SS_PERMANENT } from "./common.ts";

/**
 * Insert columns per source, in order. Each source writes only its own subset
 * (unlisted columns read back NULL). `id` is the conflict key; columns omitted
 * from a list survive a re-ingest by design:
 *   - `first_seen`/`last_seen`/`preferred` are never listed (managed by the upsert).
 *   - CAM omits `preferred` so a reorder pin survives re-scrape, and `live_url`/`external_url`
 *     so a derived host feed survives too; the cam hook maintains `live_url` via a separate
 *     UPDATE (see makeInserter), deriving it from the banner HTML on every (re)ingest.
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
	// live_url isn't in CAM_COLUMNS (so it survives re-ingest); the hook maintains it with a
	// standalone UPDATE, the same pattern setProduct uses.
	const setLiveUrl = db.query("UPDATE cams SET live_url = ? WHERE id = ?");
	return makeUpserter(db, CAM_COLUMNS, {
		afterUpsert(before, row) {
			const oldProduct = before?.product ?? ((row.product as string | null) ?? null);
			const d = decideCamProduct(oldProduct, fingerprintWebcam(row.raw_json as string));
			setProduct.run(d.product, row.id);
			recordFp.run("cam", row.id, d.tier === "-" ? null : d.tier, d.method, d.vendor === "-" ? null : d.vendor, d.evidence || null);
			// Derive a browser-playable feed URL (mjpeg/jpg) from the host's own stored HTML and
			// keep it in live_url. A non-derivable or RTSP host clears to NULL, so a host self-heals
			// when its stream path appears or disappears between scrapes. The host renderer turns an
			// https URL into a click-to-load facade and an http URL into a "View live" link.
			const feed = isRtspHost(row.port as number, d.product) ? null : deriveHostFeed(row.raw_json as string, row.ip_str as string, row.port as number);
			setLiveUrl.run(feed ? feed.liveUrl : null, row.id);
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
