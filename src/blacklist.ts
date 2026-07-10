// Blacklist: stop ingesting a host and delete what we already stored for it.
// Accepts either an IP (matched exactly, every port) or a hostname/domain
// (matches itself and any subdomain, e.g. `cloudzy.com` also drops
// `cam.node.cloudzy.com`). Future scrapes and imports skip anything listed.
// `unblacklist` reverses the listing. No API, no query credits.
//
// Usage:  bun run blacklist <ip-or-hostname>

import { isIP } from "node:net";
import {
  blacklist,
  blacklistHost,
  closeDb,
  countRows,
  deleteWebcamsByHost,
  openDb,
} from "./db.ts";

const arg = Bun.argv[2]?.trim();

if (!arg) {
  console.error("Usage: bun run blacklist <ip-or-hostname>");
  process.exit(1);
}

const db = openDb();
const startingRows = countRows(db);

try {
  console.log(`\n── Blacklist summary ──`);
  if (isIP(arg) !== 0) {
    const { changes } = db.query("DELETE FROM cams WHERE kind = 'cam' AND ip_str = ?").run(arg);
    const added = blacklist(db, arg);
    console.log(`IP:         ${arg}`);
    console.log(`Deleted:    ${changes} row(s)`);
    console.log(`Blacklist:  ${added ? "added" : "already listed"}`);
    if (changes === 0 && added) {
      console.warn(`⚠ No stored camera matched ${arg}. Check for a typo. Recorded anyway so future scrapes skip it.`);
    }
  } else {
    const deleted = deleteWebcamsByHost(db, arg);
    const added = blacklistHost(db, arg);
    console.log(`Hostname:   ${arg}`);
    console.log(`Deleted:    ${deleted} row(s)`);
    console.log(`Blacklist:  ${added ? "added" : "already listed"}`);
    if (deleted === 0 && added) {
      console.warn(`⚠ No stored camera matched ${arg}. Check for a typo. Recorded anyway so future scrapes skip it.`);
    }
  }
} finally {
  const endingRows = countRows(db);
  closeDb(db);
  console.log(`DB rows:    ${startingRows} → ${endingRows}`);
}
