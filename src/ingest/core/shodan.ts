import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { countRows, loadBlacklist, makeInserter } from "../../db/db.ts";
import { scanBanners, toBanners } from "../shodan-source.ts";

// ── Shodan ────────────────────────────────────────────────────────────────────

/** Silent single-file/paste result (also the shape the web toast reads). */
interface ShodanReport {
  added: number;
  updated: number;
  changed: number;
  banners: number;
  screenshots: number;
  blocked: number;
  blacklisted: number;
  /** Banners with no screenshot (skipped): banners − screenshots − blocked − blacklisted. */
  skipped: number;
}

/**
 * Load every `*.json` in `dir` into the webcams table (no API, no credits). Prints
 * per-file progress and a summary; only banners with a screenshot are stored.
 */
export async function ingestShodanDir(db: Database, dir: string): Promise<void> {
  const paths = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: dir, absolute: true }))).sort();
  if (paths.length === 0) {
    console.log(`No .json files found in ${dir}/. Nothing to import.`);
    return;
  }

  const insertMany = makeInserter(db);
  const startingRows = countRows(db);
  const bl = loadBlacklist(db);

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

      const scan = scanBanners(list, bl);
      banners += scan.banners;
      screenshots += scan.screenshots;
      blocked += scan.blocked;
      blacklisted += scan.blacklisted;

      const { added: a, updated: u, changed: c } = insertMany(scan.rows);
      added += a;
      updated += u;
      changed += c;
      console.log(
        `${name}: ${list.length} banners, ${scan.screenshots} with screenshot, ` +
          `+${a} new, ${u} refreshed${c ? ` (${c} new screenshot)` : ""}`,
      );
    }
  } finally {
    const endingRows = countRows(db);
    console.log(`\n── Import summary ──`);
    console.log(`Files:    ${paths.length} found, ${failed} failed to parse, ${unknown} unknown shape`);
    console.log(`Banners:  ${banners} seen, ${screenshots} with screenshot, ${blocked} rdp/vnc skipped, ${blacklisted} blacklisted, ${banners - screenshots - blocked - blacklisted} skipped (no screenshot)`);
    console.log(`New cameras added: ${added}`);
    console.log(`Refreshed:         ${updated} existing (${changed} with a changed screenshot)`);
    console.log(`DB rows:  ${startingRows} → ${endingRows}`);
  }
}

/**
 * Load banners from a single pasted JSON string (the dev-mode web importer). Silent;
 * returns the tally. Throws on invalid JSON or an unrecognized shape.
 */
export function ingestShodanText(db: Database, text: string): ShodanReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const list = toBanners(parsed);
  if (!list) throw new Error("unrecognized JSON shape (expected matches[], data[], a bare array, or one banner)");

  const scan = scanBanners(list, loadBlacklist(db));
  const { added, updated, changed } = makeInserter(db)(scan.rows);
  return {
    added,
    updated,
    changed,
    banners: scan.banners,
    screenshots: scan.screenshots,
    blocked: scan.blocked,
    blacklisted: scan.blacklisted,
    skipped: scan.banners - scan.screenshots - scan.blocked - scan.blacklisted,
  };
}

