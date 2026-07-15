// Scraper: fetch webcam screenshots from Shodan, page by page, and store new
// ones in SQLite. Idempotent, so re-runs skip cameras already saved.
//
// Usage:  bun run scrape [--pages N] [--query "..."]
//   --pages N   how many search pages to fetch (default 1). Each page = 100
//               results and costs ~1 query credit.
//   --query     override the default webcam query.

import { parseArgs } from "node:util";
import { MIN_REQUEST_MS, PER_PAGE, QUERY } from "../core/config.ts";
import { closeDb, countRows, loadBlacklist, makeInserter, openDb } from "../db/db.ts";
import { makeClient, searchPage, withBackoff } from "./shodan.ts";
import { asMatch, emitBuildNeeded, getScreenshot, isBlockedProduct, mustEnv, sleep, toRow } from "../core/util.ts";
import type { CamRow } from "../core/types.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    pages: { type: "string", short: "p", default: "1" },
    query: { type: "string", short: "q" },
  },
  allowPositionals: false,
});

const requestedPages = Math.max(1, Number.parseInt(values.pages ?? "1", 10) || 1);
const query = values.query ?? QUERY;

const client = makeClient(mustEnv("SHODANTOKEN"));
const db = openDb();
const insertMany = makeInserter(db);
const startingRows = countRows(db);
const blacklist = loadBlacklist(db);

let seen = 0;
let added = 0;
let updated = 0;
let changed = 0;
let skippedBlacklist = 0;
let creditsBefore = 0;

try {
  creditsBefore = (await withBackoff("api-info", () => client.getApiInfo())).query_credits;
  const { total } = await withBackoff("count", () => client.countHosts(query));
  const maxPages = Math.ceil(total / PER_PAGE); // 0 when the query has no results
  // Every filtered page costs 1 credit; never plan to spend more than we hold.
  const plannedPages = Math.min(requestedPages, maxPages, Math.max(0, creditsBefore));

  console.log(`Query: ${query}`);
  console.log(
    `Available: ${total.toLocaleString()} results (${maxPages.toLocaleString()} pages). ` +
      `Credit balance: ${creditsBefore}.`,
  );
  console.log(`Fetching up to ${plannedPages} page(s) (requested ${requestedPages}).\n`);

  if (plannedPages < 1) {
    console.log("Nothing to fetch. No query credits remaining or no results.");
  }

  let lastRequestAt = 0;
  for (let page = 1; page <= plannedPages; page++) {
    if (lastRequestAt) {
      const since = Date.now() - lastRequestAt;
      if (since < MIN_REQUEST_MS) await sleep(MIN_REQUEST_MS - since);
    }
    lastRequestAt = Date.now();

    const res = await searchPage(client, query, page);
    if (res.matches.length === 0) {
      console.log(`page ${page}: no more results, stopping.`);
      break;
    }

    const rows: CamRow[] = [];
    let noScreenshot = 0;
    let blocked = 0;
    let blacklisted = 0;
    for (const raw of res.matches) {
      const m = asMatch(raw);
      if (blacklist.blocks(m)) {
        blacklisted++;
        continue;
      }
      const ss = getScreenshot(m);
      if (!ss) {
        noScreenshot++;
        continue;
      }
      if (isBlockedProduct(m.product)) {
        blocked++;
        continue;
      }
      const row = toRow(m, ss);
      if (row) rows.push(row);
    }

    const { added: a, updated: u, changed: c } = insertMany(rows);
    seen += res.matches.length;
    added += a;
    updated += u;
    changed += c;
    skippedBlacklist += blacklisted;

    const extra =
      (noScreenshot ? `, ${noScreenshot} no-screenshot` : "") +
      (blocked ? `, ${blocked} rdp/vnc skipped` : "") +
      (blacklisted ? `, ${blacklisted} blacklisted` : "");
    console.log(
      `page ${page}/${plannedPages}: ${res.matches.length} matches, ` +
        `${rows.length} with screenshot, +${a} new, ${u} refreshed` +
        `${c ? ` (${c} new screenshot)` : ""}${extra}`,
    );

    if (page * PER_PAGE >= res.total) {
      console.log(`reached the last page of results (total ${res.total.toLocaleString()}).`);
      break;
    }
  }
} catch (err) {
  console.error(`\nScrape failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  // Reporting only; guard each call so closeDb always runs.
  let endingRows = startingRows;
  try {
    endingRows = countRows(db);
  } catch {
    // ignore
  }
  let creditsAfter = creditsBefore;
  try {
    creditsAfter = (await withBackoff("api-info", () => client.getApiInfo())).query_credits;
  } catch {
    // ignore
  }
  closeDb(db);

  console.log(`\n── Summary ──`);
  console.log(`Matches seen:      ${seen}`);
  console.log(`New cameras added: ${added}`);
  console.log(`Refreshed:         ${updated} existing (${changed} with a changed screenshot)`);
  console.log(`Blacklisted:       ${skippedBlacklist}`);
  console.log(`DB rows:           ${startingRows} → ${endingRows}`);
  console.log(
    `Query credits:     ${creditsBefore} → ${creditsAfter} (spent ${creditsBefore - creditsAfter})`,
  );

  // Neutral stop signal for CI: only new cams or changed screenshots alter the
  // baked site, so a credits-out / nothing-new run skips the rebuild + deploy.
  emitBuildNeeded(added > 0 || changed > 0);
}
