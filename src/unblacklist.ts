// Unblacklist: remove an IP or hostname from the blacklist so it can be ingested
// again. The inverse of `bun run blacklist <ip-or-hostname>`. Does not restore
// rows that were already deleted; re-run `bun run scrape` to fetch the host
// again. No API, no query credits.
//
// Usage:  bun run unblacklist <ip-or-hostname>

import { isIP } from "node:net";
import { closeDb, openDb, unblacklist, unblacklistHost } from "./db.ts";

const arg = Bun.argv[2]?.trim();

if (!arg) {
  console.error("Usage: bun run unblacklist <ip-or-hostname>");
  process.exit(1);
}

const db = openDb();

try {
  console.log(`\n── Unblacklist summary ──`);
  if (isIP(arg) !== 0) {
    const removed = unblacklist(db, arg);
    console.log(`IP:         ${arg}`);
    console.log(`Blacklist:  ${removed ? "removed" : "not listed"}`);
  } else {
    const removed = unblacklistHost(db, arg);
    console.log(`Hostname:   ${arg}`);
    console.log(`Blacklist:  ${removed ? "removed" : "not listed"}`);
  }
} finally {
  closeDb(db);
}
