// Feature: pin which cam/stream is showcased on the homepage (index.html). There
// are two slots per kind; the homepage renders each slot's card first, then fills
// the rest with the newest of that kind. The pin lives in the `featured` table and
// is keyed on (kind, slot), so re-featuring a slot replaces it. Re-run
// `bun run bake` afterwards. No API, no query credits.
//
// Usage:  bun run feature cam    <slot> <ip>          pin an IP into a cam slot
//         bun run feature stream <slot> <video_id>    pin a video into a stream slot

import { isIP } from "node:net";
import { closeDb, hasHost, hasStream, openDb, setFeatured } from "./db.ts";

const kind = Bun.argv[2]?.trim();
const slotArg = Bun.argv[3]?.trim();
const ref = Bun.argv[4]?.trim();

if ((kind !== "cam" && kind !== "stream") || !slotArg || !ref) {
  console.error("Usage: bun run feature <cam|stream> <slot> <ref>");
  process.exit(1);
}

const slot = Number(slotArg);
if (!Number.isInteger(slot) || slot < 1 || slot > 2) {
  console.error(`Invalid slot "${slotArg}". Expected 1 or 2.`);
  process.exit(1);
}

// A cam is pinned by IP; validate it so a typo can't quietly become a dead slot.
// A stream is pinned by YouTube video id, which we can't shape-check, so accept any.
if (kind === "cam" && isIP(ref) === 0) {
  console.error(`Invalid IP "${ref}". Expected an IPv4 or IPv6 address.`);
  process.exit(1);
}

const db = openDb();

try {
  setFeatured(db, kind, slot, ref);
  const stored = kind === "cam" ? hasHost(db, ref) : hasStream(db, ref);
  console.log(`\n── Feature summary ──`);
  console.log(`Kind:       ${kind}`);
  console.log(`Slot:       ${slot}`);
  console.log(`Ref:        ${ref}`);
  console.log(`Applied:    featured on the homepage`);
  if (!stored) {
    const what = kind === "cam" ? "cameras" : "stream";
    console.warn(`⚠ ${ref} has no stored ${what}. Check for a typo. Recorded anyway; it shows once that ${kind} is ingested.`);
  }
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
