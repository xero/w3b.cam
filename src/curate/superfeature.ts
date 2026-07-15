// Super-feature: group one or more feed cams under an event key so they render together on a
// combined /event/<key> page and get a banner promoted above everything on the homepage. Meant
// for one-off events (e.g. a bridge demolition streamed hi-res on one source and as a low-res
// traffic cam on another). The pins live in the `meta` table (type='superfeature', value=key),
// so re-running is idempotent. The FIRST feed listed is the primary: its image and name drive
// the banner and the combined page's title. Re-run `bun run bake` afterwards. No API, no credits.
//
// Usage:  bun run superfeature <event-key> <feed-id> [<feed-id> ...]
//   e.g.  bun run superfeature i376-demolition pacast-i376-demolition mjpeg-511pa-6381

import { addSuperFeature, closeDb, hasFeed, openDb } from "../db/db.ts";

const key = Bun.argv[2]?.trim();
const feedIds = Bun.argv.slice(3).map((s) => s.trim()).filter(Boolean);

if (!key || feedIds.length === 0) {
  console.error("Usage: bun run superfeature <event-key> <feed-id> [<feed-id> ...]");
  process.exit(1);
}

const db = openDb();
try {
  console.log(`\n── Super-feature summary ──`);
  console.log(`Event key:  ${key}`);
  feedIds.forEach((id, i) => {
    const added = addSuperFeature(db, key, id);
    const role = i === 0 ? " (primary)" : "";
    console.log(`  ${added ? "+" : "="} ${id}${role}${added ? "" : " (already in group)"}`);
    if (!hasFeed(db, id)) console.warn(`  ⚠ ${id} has no stored feed cam. Check for a typo. Recorded anyway; it shows once that feed is ingested.`);
  });
  console.log(`Next:       run \`bun run bake\` to regenerate the site (homepage banner + /event/${key}).`);
} finally {
  closeDb(db);
}
