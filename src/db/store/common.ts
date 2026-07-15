// Low-level helpers shared across the store modules (schema, tags, moderation, inserts).
// Kept internal — the db.ts barrel deliberately does NOT re-export this module, so these
// stay off the public DB surface.

/** Canonical host key: trimmed, lowercased, trailing FQDN dot removed. */
export function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Canonical tag key: trimmed and lowercased, so casing/whitespace never dupes a tag. */
export function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase();
}

/**
 * last_seen sentinel marking a hand-set thumbnail (see setThumbnail) that a re-scan must
 * never overwrite. A valid, maximal datetime string no `datetime('now')` write can produce;
 * the cams upserter preserves both the image and this sentinel on conflict. A fixed constant,
 * never input.
 */
export const SS_PERMANENT = "9999-12-31 23:59:59";
