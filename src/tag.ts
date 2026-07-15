// Tag: attach a free-form metadata tag to a cam, stream, or feed entry, stored in
// the unified `tags` table. `kind` selects the source and `ref` is that source's key:
// an IP (cam), a YouTube video id (stream), or an Osiris cam id (feed). A single
// entity may carry several tags; they render comma-joined on its detail page and drive
// the tag cloud and browse pages. Tags are normalized (trimmed + lowercased) so
// casing/whitespace never dupes one. Re-run `bun run bake` afterwards. No API, no query credits.
//
// Usage:  bun run tag <cam|stream|feed> <ref> <tag>

import { addTag, closeDb, openDb } from "./db.ts";
import { parseKindRef, warnIfMissing } from "./cli.ts";

const { kind, ref, tag } = parseKindRef("Usage: bun run tag <cam|stream|feed> <ref> <tag>", { needTag: true });

const db = openDb();

try {
  const added = addTag(db, kind, ref, tag);
  console.log(`\n── Tag summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Tag:        ${tag.toLowerCase()}`);
  console.log(`Applied:    ${added ? "added" : "already tagged"}`);
  warnIfMissing(db, kind, ref, "applies");
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
