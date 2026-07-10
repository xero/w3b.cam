// Untag: remove a tag from a cam, stream, or feed entry in the unified `tags`
// table. The inverse of `bun run tag`; `kind` selects the source and `ref` is that
// source's key (an IP, a YouTube video id, or an Osiris cam id). Re-run `bun run bake`
// afterwards to drop it from the site. No API, no query credits.
//
// Usage:  bun run untag <cam|stream|feed> <ref> <tag>

import { isIP } from "node:net";
import { closeDb, openDb, removeTag } from "./db.ts";

const kind = Bun.argv[2]?.trim();
const ref = Bun.argv[3]?.trim();
const tag = Bun.argv[4]?.trim();

if ((kind !== "cam" && kind !== "stream" && kind !== "feed") || !ref || !tag) {
  console.error("Usage: bun run untag <cam|stream|feed> <ref> <tag>");
  process.exit(1);
}

// A cam is keyed by IP; validate it so a typo can't silently match nothing. Stream
// (video id) and feed (namespaced id) refs are opaque strings, so accept any.
if (kind === "cam" && isIP(ref) === 0) {
  console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
  process.exit(1);
}

const db = openDb();

try {
  const removed = removeTag(db, kind, ref, tag);
  console.log(`\n── Untag summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Tag:        ${tag.toLowerCase()}`);
  console.log(`Applied:    ${removed ? "removed" : "was not tagged"}`);
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
