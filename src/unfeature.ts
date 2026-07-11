// Unfeature: remove a cam/stream/feed from the homepage's featured set (index.html). The
// inverse of `bun run feature`; `kind` selects the source and `ref` is that source's
// key (an IP, a YouTube video id, or a feed id). Re-run `bun run bake` afterwards to drop
// it from the homepage rotation. No API, no query credits.
//
// Usage:  bun run unfeature <cam|stream|feed> <ref>

import { isIP } from "node:net";
import { closeDb, openDb, removeFeatured } from "./db.ts";

const kind = Bun.argv[2]?.trim();
const ref = Bun.argv[3]?.trim();

if ((kind !== "cam" && kind !== "stream" && kind !== "feed") || !ref) {
  console.error("Usage: bun run unfeature <cam|stream|feed> <ref>");
  process.exit(1);
}

// A cam is featured by IP; validate it so a typo can't silently match nothing. A stream
// (video id) and a feed (slug id) ref are opaque strings, so accept any.
if (kind === "cam" && isIP(ref) === 0) {
  console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
  process.exit(1);
}

const db = openDb();

try {
  const removed = removeFeatured(db, kind, ref);
  console.log(`\n── Unfeature summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Applied:    ${removed ? "removed from the homepage" : "was not featured"}`);
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
