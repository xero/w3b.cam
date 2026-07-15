import type { Database } from "bun:sqlite";
import type { TagKind } from "./schema.ts";
import { normalizeTag } from "./common.ts";

// ── Tags (kind='cam'|'stream'|'feed', type='tag' on the `meta` table) ──────────

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
