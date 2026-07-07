// Purge: remove stored cameras whose product we filter at ingestion (RDP/VNC).
// The ingestion guard only blocks *new* rows, so this retroactively drops any that
// predate it. Re-run `bun run bake` afterwards. No API, no query credits.
//
// Usage:  bun run purge

import { closeDb, countRows, deleteBlockedProducts, openDb } from "./db.ts";

const db = openDb();
const startingRows = countRows(db);

try {
  const removed = deleteBlockedProducts(db);
  console.log(`\n── Purge summary ──`);
  console.log(`Removed:    ${removed} row(s) (RDP/VNC and other blocked products)`);
} finally {
  const endingRows = countRows(db);
  closeDb(db);
  console.log(`DB rows:    ${startingRows} → ${endingRows}`);
}
