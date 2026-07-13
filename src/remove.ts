// Remove: delete a stored entry from the DB WITHOUT blacklisting it. Unlike `blacklist`,
// nothing is recorded to keep it out — a removed entry returns the next time its source is
// re-ingested (scrape / import / osiris / youtube). Also clears the entry's tags and
// featured pins. Works for every kind: a host cam (all ports), a YouTube stream, or a feed
// cam. Use `blacklist` instead when you want a host gone for good.
//
// Usage:  bun run remove [--kind cam|stream|feed] <ref>
//   cam (default): <ref> is an IP (matched exactly, every port) or a hostname/domain
//                  (matches itself and any subdomain, like `blacklist`).
//   stream|feed:   <ref> is the stored id (video id / feed id).

import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { closeDb, countRows, openDb, removeEntity, removeWebcamsByHost } from "./db.ts";

function usage(): never {
  console.error("Usage: bun run remove [--kind cam|stream|feed] <ref>");
  console.error("  cam (default): <ref> is an IP (every port) or a hostname/domain");
  console.error("  stream|feed:   <ref> is the stored id");
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { kind: { type: "string", default: "cam" } },
  allowPositionals: true,
});

const kind = values.kind;
if (kind !== "cam" && kind !== "stream" && kind !== "feed") usage();

const ref = positionals[0]?.trim();
if (!ref) usage();

const db = openDb();
const startingRows = countRows(db);

try {
  let deleted: number;
  if (kind === "cam") {
    deleted = isIP(ref) !== 0 ? removeEntity(db, "cam", ref) : removeWebcamsByHost(db, ref);
  } else {
    deleted = removeEntity(db, kind, ref);
  }

  console.log(`\n── Remove summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Target:     ${ref}`);
  console.log(`Deleted:    ${deleted} row(s)`);
  if (deleted === 0) {
    console.warn(`⚠ No stored ${kind} matched ${ref}. Check for a typo; nothing removed.`);
  }
} finally {
  const endingRows = countRows(db);
  closeDb(db);
  console.log(`DB rows:    ${startingRows} → ${endingRows}`);
}
