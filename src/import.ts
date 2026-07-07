// Importer: load raw Shodan JSON files from a local directory into the database.
// No API, no query credits. Files are read in place and never modified.
//
// Usage:  bun run import [dir]   (default dir: ./in)
//
// Accepts host-info objects (a `data[]` array of banners), search responses
// (`matches[]`), a bare array of banners, or a single banner. Only banners that
// carry a screenshot are stored; the rest are counted and skipped. Files that
// fail to parse are skipped with a warning.

import { basename } from "node:path";
import { IN_DIR } from "./config.ts";
import { closeDb, countRows, loadBlacklist, makeInserter, openDb } from "./db.ts";
import { asMatch, getScreenshot, isBlockedProduct, toRow } from "./util.ts";
import type { CamRow, WebcamMatch } from "./types.ts";

const dir = Bun.argv[2] ?? IN_DIR;

/** Normalize any supported JSON shape into a flat list of banners, or null if unrecognized. */
function toBanners(parsed: unknown): WebcamMatch[] | null {
  if (Array.isArray(parsed)) return parsed as WebcamMatch[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    if (Array.isArray(o.matches)) return o.matches as WebcamMatch[]; // search response
    if (Array.isArray(o.data)) return o.data as WebcamMatch[]; // host-info object
    if (typeof o.port === "number") return [parsed as WebcamMatch]; // single banner
  }
  return null;
}

const paths = (
  await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, absolute: true }))
).sort();

if (paths.length === 0) {
  console.log(`No .json files found in ${dir}/. Nothing to import.`);
  process.exit(0);
}

const db = openDb();
const insertMany = makeInserter(db);
const startingRows = countRows(db);
const blacklist = loadBlacklist(db);

let failed = 0;
let unknown = 0;
let banners = 0;
let screenshots = 0;
let blocked = 0;
let blacklisted = 0;
let added = 0;
let updated = 0;
let changed = 0;

try {
  for (const path of paths) {
    const name = basename(path);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(path).text());
    } catch (err) {
      failed++;
      console.warn(`skip ${name}: invalid JSON (${err instanceof Error ? err.message : err})`);
      continue;
    }

    const list = toBanners(parsed);
    if (!list) {
      unknown++;
      console.warn(`skip ${name}: unrecognized JSON shape`);
      continue;
    }

    const rows: CamRow[] = [];
    let fileScreenshots = 0;
    for (const raw of list) {
      banners++;
      const m = asMatch(raw);
      if (blacklist.blocks(m)) {
        blacklisted++;
        continue;
      }
      const ss = getScreenshot(m);
      if (!ss) continue;
      if (isBlockedProduct(m.product)) {
        blocked++;
        continue;
      }
      fileScreenshots++;
      screenshots++;
      const row = toRow(m, ss);
      if (row) rows.push(row);
    }

    const { added: a, updated: u, changed: c } = insertMany(rows);
    added += a;
    updated += u;
    changed += c;
    console.log(
      `${name}: ${list.length} banners, ${fileScreenshots} with screenshot, ` +
        `+${a} new, ${u} refreshed${c ? ` (${c} new screenshot)` : ""}`,
    );
  }
} finally {
  const endingRows = countRows(db);
  closeDb(db);

  console.log(`\n── Import summary ──`);
  console.log(`Files:    ${paths.length} found, ${failed} failed to parse, ${unknown} unknown shape`);
  console.log(`Banners:  ${banners} seen, ${screenshots} with screenshot, ${blocked} rdp/vnc skipped, ${blacklisted} blacklisted, ${banners - screenshots - blocked - blacklisted} skipped (no screenshot)`);
  console.log(`New cameras added: ${added}`);
  console.log(`Refreshed:         ${updated} existing (${changed} with a changed screenshot)`);
  console.log(`DB rows:  ${startingRows} → ${endingRows}`);
}
