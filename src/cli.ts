// Shared helpers for the small curation CLIs (tag, untag, feature, unfeature): argument
// parsing and the "not stored yet" typo warning, so each script stays a thin wrapper.

import { isIP } from "node:net";
import type { Database } from "bun:sqlite";
import { hasFeed, hasHost, hasStream, type TagKind } from "./db.ts";

/**
 * Parse `<cam|stream|feed> <ref> [tag]` from argv. Prints `usage` and exits(1) on a bad
 * kind, a missing ref, or (when `needTag`) a missing tag; for a cam it also rejects a
 * non-IP ref so a typo can't become a dead entry. Stream (video id) and feed (namespaced
 * id) refs are opaque, so any non-empty string is accepted.
 */
export function parseKindRef(usage: string, { needTag = false }: { needTag?: boolean } = {}): { kind: TagKind; ref: string; tag: string } {
  const kind = Bun.argv[2]?.trim();
  const ref = Bun.argv[3]?.trim();
  const tag = Bun.argv[4]?.trim();
  if ((kind !== "cam" && kind !== "stream" && kind !== "feed") || !ref || (needTag && !tag)) {
    console.error(usage);
    process.exit(1);
  }
  if (kind === "cam" && isIP(ref) === 0) {
    console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
    process.exit(1);
  }
  return { kind, ref, tag: tag ?? "" };
}

/**
 * Warn when `ref` has no matching stored entity, so a mistyped ref surfaces instead of
 * silently recording a tag/pin that never applies. `verb` is how the recorded entry takes
 * effect once the entity is ingested ("applies" for a tag, "shows" for a feature).
 */
export function warnIfMissing(db: Database, kind: TagKind, ref: string, verb: string): void {
  const stored = kind === "cam" ? hasHost(db, ref) : kind === "stream" ? hasStream(db, ref) : hasFeed(db, ref);
  if (stored) return;
  const what = kind === "cam" ? "cameras" : kind === "stream" ? "stream" : "feed cam";
  console.warn(`⚠ ${ref} has no stored ${what}. Check for a typo. Recorded anyway; it ${verb} once that ${kind} is ingested.`);
}
