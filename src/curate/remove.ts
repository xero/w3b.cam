// Remove: delete a stored entry from the DB WITHOUT blacklisting it. Unlike `blacklist`,
// nothing is recorded to keep it out — a removed entry returns the next time its source is
// re-ingested (scrape / import / osiris / youtube). Also clears the entry's tags and
// featured pins. Works for every kind: a host cam (all ports), a YouTube stream, a feed
// cam, or an image (every row serving that screenshot). Use `blacklist` instead when you
// want a host or image gone for good.
//
// Usage:  bun run remove [--kind cam|stream|feed|image] <ref>
//   cam (default): <ref> is an IP (matched exactly, every port) or a hostname/domain
//                  (matches itself and any subdomain, like `blacklist`).
//   stream|feed:   <ref> is the stored id (video id / feed id).
//   image:         <ref> is the 16-hex image hash from an /img/<hash>.jpg URL; every
//                  row serving that exact screenshot is removed, across all hosts.

import { isIP } from "node:net";
import { parseArgs } from "node:util";
import {
  closeDb,
  countRows,
  deleteWebcamsByImageHash,
  normalizeImageHash,
  openDb,
  removeEntity,
  removeWebcamsByHost,
} from "../db/db.ts";

function usage(): never {
  console.error("Usage: bun run remove [--kind cam|stream|feed|image] <ref>");
  console.error("  cam (default): <ref> is an IP (every port) or a hostname/domain");
  console.error("  stream|feed:   <ref> is the stored id");
  console.error("  image:         <ref> is the 16-hex image hash from an /img/<hash>.jpg URL");
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { kind: { type: "string", default: "cam" } },
  allowPositionals: true,
});

const kind = values.kind;
if (kind !== "cam" && kind !== "stream" && kind !== "feed" && kind !== "image") usage();

const ref = positionals[0]?.trim();
if (!ref) usage();

const db = openDb();
const startingRows = countRows(db);

try {
  let deleted: number;
  let target = ref;
  if (kind === "image") {
    const norm = normalizeImageHash(ref);
    if (!norm) {
      console.error(`Not a valid image hash: ${ref} (expected the 16-hex hash from an /img/<hash>.jpg URL)`);
      process.exit(1);
    }
    target = norm;
    deleted = deleteWebcamsByImageHash(db, ref).rows;
  } else if (kind === "cam") {
    deleted = isIP(ref) !== 0 ? removeEntity(db, "cam", ref) : removeWebcamsByHost(db, ref);
  } else {
    deleted = removeEntity(db, kind, ref);
  }

  console.log(`\n── Remove summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Target:     ${target}`);
  console.log(`Deleted:    ${deleted} row(s)`);
  if (deleted === 0) {
    console.warn(`⚠ No stored ${kind} matched ${target}. Check for a typo; nothing removed.`);
  }
} finally {
  const endingRows = countRows(db);
  closeDb(db);
  console.log(`DB rows:    ${startingRows} → ${endingRows}`);
}
