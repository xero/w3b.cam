// Feature: add a cam/stream/feed to the homepage's featured set (index.html). The homepage
// randomly shows a couple of the featured entries per kind on each build, then fills the
// rest of the row with the newest of that kind. The pin lives in the `featured` table
// keyed on (kind, ref), so re-featuring the same ref is idempotent. Re-run `bun run bake`
// afterwards; remove one with `bun run unfeature`. No API, no query credits.
//
// Usage:  bun run feature cam    <ip>          feature an IP (a cam)
//         bun run feature stream <video_id>    feature a YouTube stream
//         bun run feature feed   <feed_id>     feature a feed cam (mjpeg / hls / osiris)

import { isIP } from "node:net";
import { addFeatured, closeDb, hasFeed, hasHost, hasStream, openDb } from "./db.ts";

const kind = Bun.argv[2]?.trim();
const ref = Bun.argv[3]?.trim();

if ((kind !== "cam" && kind !== "stream" && kind !== "feed") || !ref) {
  console.error("Usage: bun run feature <cam|stream|feed> <ref>");
  process.exit(1);
}

// A cam is featured by IP; validate it so a typo can't quietly become a dead pin. A stream
// is featured by video id and a feed by its slug id, neither of which we can shape-check.
if (kind === "cam" && isIP(ref) === 0) {
  console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
  process.exit(1);
}

const db = openDb();

try {
  const added = addFeatured(db, kind, ref);
  const stored = kind === "cam" ? hasHost(db, ref) : kind === "stream" ? hasStream(db, ref) : hasFeed(db, ref);
  console.log(`\n── Feature summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Applied:    ${added ? "featured on the homepage" : "already featured"}`);
  if (!stored) {
    const what = kind === "cam" ? "cameras" : kind === "stream" ? "stream" : "feed cam";
    console.warn(`⚠ ${ref} has no stored ${what}. Check for a typo. Recorded anyway; it shows once that ${kind} is ingested.`);
  }
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
