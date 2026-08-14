// Blacklist: stop ingesting something and delete what we already stored for it.
// Accepts three kinds of target, auto-detected:
//   • an IP        — matched exactly, every port
//   • a hostname   — matches itself and any subdomain (e.g. `cloudzy.com` also drops
//                    `cam.node.cloudzy.com`)
//   • an image hash — the 16-hex hash from an image URL (/img/<hash>.jpg). Blocks by
//                     CONTENT: removes that exact screenshot from every host serving it
//                     and skips it on future ingests, no matter which IP it reappears on.
//                     Use this for spam hosts that rotate IPs but serve one static image.
// Future scrapes and imports skip anything listed. `unblacklist` reverses the listing.
// No API, no query credits.
//
// Usage:  bun run blacklist <ip | hostname | image-hash>

import { isIP } from "node:net";
import {
  blacklist,
  blacklistHost,
  blacklistImage,
  closeDb,
  countRows,
  deleteWebcamsByHost,
  deleteWebcamsByImageHash,
  deleteWebcamsByIp,
  isImageHash,
  normalizeImageHash,
  openDb,
} from "../db/db.ts";

const arg = Bun.argv[2]?.trim();

if (!arg) {
  console.error("Usage: bun run blacklist <ip | hostname | image-hash>");
  process.exit(1);
}

const db = openDb();
const startingRows = countRows(db);

try {
  console.log(`\n── Blacklist summary ──`);
  if (isImageHash(arg)) {
    const { rows, hosts } = deleteWebcamsByImageHash(db, arg);
    const added = blacklistImage(db, arg);
    console.log(`Image hash: ${normalizeImageHash(arg)}`);
    console.log(`Deleted:    ${rows} row(s) across ${hosts} host(s)`);
    console.log(`Blacklist:  ${added ? "added" : "already listed"}`);
    if (rows === 0 && added) {
      console.warn(`⚠ No stored camera used this image. Recorded anyway so future ingests skip it.`);
    }
  } else if (isIP(arg) !== 0) {
    const changes = deleteWebcamsByIp(db, arg);
    const added = blacklist(db, arg);
    console.log(`IP:         ${arg}`);
    console.log(`Deleted:    ${changes} row(s)`);
    console.log(`Blacklist:  ${added ? "added" : "already listed"}`);
    if (changes === 0 && added) {
      console.warn(`⚠ No stored camera matched ${arg}. Check for a typo. Recorded anyway so future scrapes skip it.`);
    }
  } else {
    const deleted = deleteWebcamsByHost(db, arg).rows;
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
