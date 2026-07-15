// Reorder: choose which screenshot represents a multi-port host on its gallery
// card. By default the newest screenshot wins; this pins a specific (ip, port) so
// the renderer uses it instead. The pin lives in a `preferred` column the importer
// never writes, so it survives re-scrapes. Re-run `bun run bake` afterwards.
//
// Usage:  bun run reorder <ip> <port>     pin ip:port as the card image
//         bun run reorder <ip> --clear    revert ip to the newest screenshot

import { isIP } from "node:net";
import { clearPreferred, closeDb, hasHost, openDb, setPreferred } from "../db/db.ts";

const ip = Bun.argv[2];
const portArg = Bun.argv[3];

if (!ip || isIP(ip) === 0 || !portArg) {
  console.error("Usage: bun run reorder <ip> <port>   |   bun run reorder <ip> --clear");
  process.exit(1);
}

const clearing = portArg === "--clear";
let port = -1;
if (!clearing) {
  port = Number(portArg);
  if (!Number.isInteger(port) || port < 0) {
    console.error(`Invalid port "${portArg}". Expected a non-negative integer (or --clear).`);
    process.exit(1);
  }
}

const db = openDb();
let failed = false;

try {
  if (clearing) {
    const cleared = clearPreferred(db, ip);
    console.log(`\n── Reorder summary ──`);
    console.log(`IP:         ${ip}`);
    console.log(`Pin:        ${cleared ? "cleared, reverts to newest screenshot" : "none was set"}`);
    if (!cleared && !hasHost(db, ip)) {
      console.warn(`⚠ ${ip} isn't in the DB. Check for a typo.`);
    }
    console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
  } else if (setPreferred(db, ip, port)) {
    console.log(`\n── Reorder summary ──`);
    console.log(`IP:         ${ip}`);
    console.log(`Preferred:  port ${port}, now this host's card image`);
    console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
  } else {
    const why = hasHost(db, ip) ? `port ${port} not found for ${ip}` : `${ip} isn't in the DB (typo?)`;
    console.error(`No stored screenshot for ${ip}:${port} (${why}). Nothing changed.`);
    failed = true;
  }
} finally {
  closeDb(db);
}

if (failed) process.exit(1);
