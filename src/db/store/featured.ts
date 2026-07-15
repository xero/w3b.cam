import type { Database } from "bun:sqlite";
import type { TagKind } from "./schema.ts";

// ── Featured (homepage pins, type='featured' on the `meta` table) ──────────────

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
export function addFeatured(db: Database, kind: TagKind, ref: string): boolean {
	return db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES (?, ?, 'featured', '')").run(kind, ref).changes > 0;
}

/** Un-feature (kind, ref). True if a row was deleted, false if it was not featured. */
export function removeFeatured(db: Database, kind: TagKind, ref: string): boolean {
	return db.query("DELETE FROM meta WHERE kind = ? AND ref = ? AND type = 'featured'").run(kind, ref).changes > 0;
}

/** True when (kind, ref) is currently featured. */
export function isFeatured(db: Database, kind: TagKind, ref: string): boolean {
	return db.query("SELECT 1 FROM meta WHERE kind = ? AND ref = ? AND type = 'featured' LIMIT 1").get(kind, ref) != null;
}

// ── Super-feature (one-off event groups) ──────────────────────────────────────
// A `superfeature` meta row groups feeds that show the same thing (e.g. a hi-res
// stream + a lower-res traffic cam of one bridge demolition). `value` is the shared
// event key; members of a key render together on a combined /event/<key> page and get
// a banner promoted above everything on the homepage. The first-added member is the
// "primary" (its image + name drive the banner and page title). Currently feed-only.

/**
 * Every super-feature group as key -> [feed ids], insertion order preserved so the first
 * id is the primary. Feeds whose row is gone are still listed; the build skips them.
 */
export function loadSuperFeatures(db: Database): Map<string, string[]> {
	// rowid is the true insertion order (added_at only has 1s granularity, so members added
	// in the same second would tiebreak by ref and mis-pick the primary).
	const rows = db
		.query("SELECT ref, value FROM meta WHERE type = 'superfeature' AND kind = 'feed' ORDER BY value, rowid")
		.all() as { ref: string; value: string }[];
	const groups = new Map<string, string[]>();
	for (const r of rows) {
		const list = groups.get(r.value);
		if (list) list.push(r.ref);
		else groups.set(r.value, [r.ref]);
	}
	return groups;
}

/** Add a feed to the super-feature group `key`. Idempotent; true if newly added. */
export function addSuperFeature(db: Database, key: string, feedId: string): boolean {
	return db.query("INSERT OR IGNORE INTO meta (kind, ref, type, value) VALUES ('feed', ?, 'superfeature', ?)").run(feedId, key).changes > 0;
}

/** Remove a feed from the super-feature group `key`. True if a row was deleted. */
export function removeSuperFeature(db: Database, key: string, feedId: string): boolean {
	return db.query("DELETE FROM meta WHERE kind = 'feed' AND ref = ? AND type = 'superfeature' AND value = ?").run(feedId, key).changes > 0;
}
