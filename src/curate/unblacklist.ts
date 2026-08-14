// Unblacklist: remove an IP, hostname, or image hash from the blacklist so it can be
// ingested again. The inverse of `bun run blacklist <ip | hostname | image-hash>`. Does
// not restore rows that were already deleted; re-run `bun run scrape` (or re-ingest the
// source) to fetch the target again. No API, no query credits.
//
// Usage:  bun run unblacklist <ip | hostname | image-hash>

import { isIP } from "node:net";
import {
  closeDb,
  isImageHash,
  normalizeImageHash,
  openDb,
  unblacklist,
  unblacklistHost,
  unblacklistImage,
} from "../db/db.ts";

const arg = Bun.argv[2]?.trim();

if (!arg) {
  console.error("Usage: bun run unblacklist <ip | hostname | image-hash>");
  process.exit(1);
}

const db = openDb();

try {
  console.log(`\n── Unblacklist summary ──`);
  if (isImageHash(arg)) {
    const removed = unblacklistImage(db, arg);
    console.log(`Image hash: ${normalizeImageHash(arg)}`);
    console.log(`Blacklist:  ${removed ? "removed" : "not listed"}`);
    if (!removed) console.warn(`⚠ That image hash was not in the blacklist. Check for a typo if you expected it to be listed.`);
  } else if (isIP(arg) !== 0) {
    const removed = unblacklist(db, arg);
    console.log(`IP:         ${arg}`);
    console.log(`Blacklist:  ${removed ? "removed" : "not listed"}`);
    if (!removed) console.warn(`⚠ ${arg} was not in the blacklist. Check for a typo if you expected it to be listed.`);
  } else {
    const removed = unblacklistHost(db, arg);
    console.log(`Hostname:   ${arg}`);
    console.log(`Blacklist:  ${removed ? "removed" : "not listed"}`);
    if (!removed) console.warn(`⚠ ${arg} was not in the blacklist. Check for a typo if you expected it to be listed.`);
  }
} finally {
  closeDb(db);
}
