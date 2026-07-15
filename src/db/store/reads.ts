import type { Database } from "bun:sqlite";
import type { StoredRow, StoredFeedRow, StoredYtRow } from "../../core/types.ts";
import type { TagKind } from "./schema.ts";

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
