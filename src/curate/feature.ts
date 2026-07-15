// Feature: add a cam/stream/feed to the homepage's featured set (index.html). The homepage
// randomly shows a couple of the featured entries per kind on each build, then fills the
// rest of the row with the newest of that kind. The pin lives in the `featured` table
// keyed on (kind, ref), so re-featuring the same ref is idempotent. Re-run `bun run bake`
// afterwards; remove one with `bun run unfeature`. No API, no query credits.
//
// Usage:  bun run feature cam    <ip>          feature an IP (a cam)
//         bun run feature stream <video_id>    feature a YouTube stream
//         bun run feature feed   <feed_id>     feature a feed cam (mjpeg / hls / osiris)

import { addFeatured, closeDb, openDb } from "../db/db.ts";
import { parseKindRef, warnIfMissing } from "../core/cli.ts";

const { kind, ref } = parseKindRef("Usage: bun run feature <cam|stream|feed> <ref>");

const db = openDb();

try {
  const added = addFeatured(db, kind, ref);
  console.log(`\n── Feature summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Applied:    ${added ? "featured on the homepage" : "already featured"}`);
  warnIfMissing(db, kind, ref, "shows");
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
