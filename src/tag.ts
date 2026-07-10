// Tag: attach a free-form metadata tag to a cam, stream, or feed entry, stored in
// the unified `tags` table. `kind` selects the source and `ref` is that source's key:
// an IP (cam), a YouTube video id (stream), or an Osiris cam id (feed). A single
// entity may carry several tags; they render comma-joined on its detail page and drive
// the tag cloud and browse pages. Tags are normalized (trimmed + lowercased) so
// casing/whitespace never dupes one. Re-run `bun run bake` afterwards. No API, no query credits.
//
// Usage:  bun run tag <cam|stream|feed> <ref> <tag>

import { isIP } from "node:net";
import { addTag, closeDb, hasHost, hasStream, hasFeed, openDb } from "./db.ts";

const kind = Bun.argv[2]?.trim();
const ref = Bun.argv[3]?.trim();
const tag = Bun.argv[4]?.trim();

if ((kind !== "cam" && kind !== "stream" && kind !== "feed") || !ref || !tag) {
  console.error("Usage: bun run tag <cam|stream|feed> <ref> <tag>");
  process.exit(1);
}

// A cam is keyed by IP; validate it so a typo can't quietly become a dead tag. Stream
// (video id) and feed (namespaced id) refs are opaque strings, so accept any.
if (kind === "cam" && isIP(ref) === 0) {
  console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
  process.exit(1);
}

const db = openDb();

try {
  const added = addTag(db, kind, ref, tag);
  const stored = kind === "cam" ? hasHost(db, ref) : kind === "stream" ? hasStream(db, ref) : hasFeed(db, ref);
  console.log(`\n── Tag summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Tag:        ${tag.toLowerCase()}`);
  console.log(`Applied:    ${added ? "added" : "already tagged"}`);
  if (!stored) {
    const what = kind === "cam" ? "cameras" : kind === "stream" ? "stream" : "feed cam";
    console.warn(`⚠ ${ref} has no stored ${what}. Check for a typo. Recorded anyway; it applies once that ${kind} is ingested.`);
  }
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
