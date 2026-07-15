// Unfeature: remove a cam/stream/feed from the homepage's featured set (index.html). The
// inverse of `bun run feature`; `kind` selects the source and `ref` is that source's
// key (an IP, a YouTube video id, or a feed id). Re-run `bun run bake` afterwards to drop
// it from the homepage rotation. No API, no query credits.
//
// Usage:  bun run unfeature <cam|stream|feed> <ref>

import { closeDb, openDb, removeFeatured } from "../db/db.ts";
import { parseKindRef } from "../core/cli.ts";

const { kind, ref } = parseKindRef("Usage: bun run unfeature <cam|stream|feed> <ref>");

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
