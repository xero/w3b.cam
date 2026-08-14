// Un-super-feature: pull a completed event's group off the homepage banner and remove its
// combined /event/<key> page. The inverse of `bun run superfeature`. By default removes the
// ENTIRE event (every feed under the key); pass specific feed ids to drop only those and
// leave the rest of the group intact. The pins live in the `meta` table
// (type='superfeature'); the feed cams themselves are untouched — they keep rendering
// normally, just not grouped as an event. Re-run `bun run bake` afterwards. No API, no credits.
//
// Usage:  bun run unsuperfeature <event-key> [<feed-id> ...]
//   e.g.  bun run unsuperfeature i376-demolition                     (remove the whole event)
//         bun run unsuperfeature i376-demolition mjpeg-511pa-6381    (drop one feed from it)

import { closeDb, loadSuperFeatures, openDb, removeSuperFeature, removeSuperFeatureEvent } from "../db/db.ts";

const key = Bun.argv[2]?.trim();
const feedIds = Bun.argv.slice(3).map((s) => s.trim()).filter(Boolean);

if (!key) {
  console.error("Usage: bun run unsuperfeature <event-key> [<feed-id> ...]");
  process.exit(1);
}

const db = openDb();
try {
  console.log(`\n── Un-super-feature summary ──`);
  console.log(`Event key:  ${key}`);
  const before = loadSuperFeatures(db).get(key);
  if (!before) {
    console.warn(`⚠ No super-feature group named "${key}". Check for a typo; nothing changed.`);
  } else if (feedIds.length === 0) {
    const removed = removeSuperFeatureEvent(db, key);
    console.log(`Removed:    entire event — ${removed} feed(s): ${before.join(", ")}`);
  } else {
    for (const id of feedIds) {
      const removed = removeSuperFeature(db, key, id);
      console.log(`  ${removed ? "-" : "="} ${id}${removed ? "" : " (not in this group)"}`);
    }
    const after = loadSuperFeatures(db).get(key);
    console.log(after ? `Remaining:  ${after.join(", ")}` : `Removed the last feed; the event group is now gone.`);
  }
  console.log(`Next:       run \`bun run bake\` (or \`bun run sync --push\`) to regenerate the site.`);
} finally {
  closeDb(db);
}
