// Untag: remove a tag from a cam, stream, or feed entry in the unified `tags`
// table. The inverse of `bun run tag`; `kind` selects the source and `ref` is that
// source's key (an IP, a YouTube video id, or an Osiris cam id). Re-run `bun run bake`
// afterwards to drop it from the site. No API, no query credits.
//
// Usage:  bun run untag <cam|stream|feed> <ref> <tag>

import { closeDb, openDb, removeTag } from "../db/db.ts";
import { parseKindRef } from "../core/cli.ts";

const { kind, ref, tag } = parseKindRef("Usage: bun run untag <cam|stream|feed> <ref> <tag>", { needTag: true });

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
