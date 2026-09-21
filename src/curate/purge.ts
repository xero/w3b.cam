// Purge: remove stored cameras the ingest guards would refuse today: RDP/VNC
// products, GIF screenshots, and the fake-camera decoy banner. Each guard only
// blocks *new* rows, so this retroactively drops any that predate it. Re-run
// `bun run bake` afterwards. No API, no query credits.
//
// Usage:  bun run purge

import { closeDb, countRows, deleteBlockedProducts, deleteDecoyBanners, deleteGifScreenshots, openDb } from "../db/db.ts";

const db = openDb();
const startingRows = countRows(db);

try {
  const products = deleteBlockedProducts(db);
  const gifs = deleteGifScreenshots(db);
  const decoys = deleteDecoyBanners(db);
  console.log(`\n── Purge summary ──`);
  console.log(`Removed:    ${products + gifs + decoys} row(s) (${products} RDP/VNC, ${gifs} GIF screenshot, ${decoys} decoy banner)`);
} finally {
  const endingRows = countRows(db);
  closeDb(db);
  console.log(`DB rows:    ${startingRows} → ${endingRows}`);
}
