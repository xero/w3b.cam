// MJPEG "camhunt" ingester: read a curated list of camera URLs (in/new/mjpeg.md),
// classify each into how it renders in the shared `traffic` table (see mjpeg-source.ts),
// grab a still for its gallery card, and upsert. Idempotent, so re-runs refresh the
// thumbnail (and last_seen) rather than duplicating cams, and appended URLs just add rows.
//
// Mirrors the youtube/traffic ingesters. Reuses the traffic snapshot + row + insert
// machinery; only the URL classification is MJPEG-specific. The live feed itself is not
// stored: the detail page embeds it at view time (mjpeg/jpg) or links to it (link).
//
// Usage:
//   bun run mjpeg [file]              (default file: in/new/mjpeg.md)
//   bun run mjpeg --limit 20          cap the number of ingested cams
//   bun run mjpeg --concurrency 32    snapshot fan-out (default 24)

import { parseArgs } from "node:util";
import { MJPEG_MD } from "./config.ts";
import { closeDb, countTrafficRows, makeTrafficInserter, openDb } from "./db.ts";
import { buildTrafficRow, fetchImage, grabFrame, hasFfmpeg } from "./traffic-source.ts";
import { classifyMjpeg, feedRank, parseMjpegList, toOsirisCam } from "./mjpeg-source.ts";
import { mapLimit } from "./util.ts";
import type { MjpegClassified } from "./mjpeg-source.ts";
import type { TrafficRow } from "./types.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", short: "l" },
    concurrency: { type: "string", short: "c" },
  },
  allowPositionals: true,
});

const file = positionals[0] ?? MJPEG_MD;
const limit = values.limit ? Math.max(1, Number.parseInt(values.limit, 10) || 0) : 0;
const concurrency = values.concurrency ? Math.max(1, Number.parseInt(values.concurrency, 10) || 0) : 24;

const raw = Bun.file(file);
if (!(await raw.exists())) {
  console.error(`Missing ${file}. Add one URL per line, or pass a path, e.g. bun run mjpeg in/new/mjpeg.md`);
  process.exit(1);
}

// ── Parse + classify + dedup (fast, in-memory) ───────────────────────────────────

const entries = parseMjpegList(await raw.text());

// Dedup by id, keeping the richest rendering of a physical cam (mjpeg > jpg > link) and
// the longest label seen. The same cam often appears as both a viewer page and a direct
// endpoint (e.g. one host as `/#view` and `/jpg/image.jpg`); those collapse to one card.
const byId = new Map<string, { cam: MjpegClassified; label: string }>();
let deferred = 0;
for (const e of entries) {
  const cam = classifyMjpeg(e.url);
  if (!cam) {
    deferred++;
    continue;
  }
  const prev = byId.get(cam.id);
  if (!prev) {
    byId.set(cam.id, { cam, label: e.label });
  } else {
    if (feedRank(cam.feed_kind) > feedRank(prev.cam.feed_kind)) prev.cam = cam;
    if (e.label.length > prev.label.length) prev.label = e.label;
  }
}

const kept = [...byId.values()];
const byVendor: Record<string, number> = {};
const byKind = { mjpeg: 0, jpg: 0, link: 0 } as Record<string, number>;
for (const { cam } of kept) {
  byVendor[cam.vendor] = (byVendor[cam.vendor] ?? 0) + 1;
  byKind[cam.feed_kind] = (byKind[cam.feed_kind] ?? 0) + 1;
}

const work = limit ? kept.slice(0, limit) : kept;

console.log(`Parsed ${entries.length} line(s): ${kept.length} unique cam(s), ${deferred} deferred (unrecognized).`);
console.log(`By vendor: ${Object.entries(byVendor).map(([v, n]) => `${v} ${n}`).join(", ") || "none"}`);
console.log(`Embeddable: mjpeg ${byKind.mjpeg} + jpg ${byKind.jpg}; screenshot-only: link ${byKind.link}.`);
if (limit && work.length < kept.length) console.log(`--limit ${limit}: ingesting ${work.length} of ${kept.length}`);
if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MJPEG-stream cams will get placeholder cards (no thumbnail).");
console.log(`Snapshotting ${work.length.toLocaleString()} cam(s) with concurrency ${concurrency}…`);

// ── Snapshot (bounded fan-out) + build rows ──────────────────────────────────────

let done = 0;
let noThumb = 0;
const rows = await mapLimit(work, concurrency, async ({ cam, label }): Promise<TrafficRow> => {
  // fetchImage first (fast, handles single-JPEG snapshots and bails on multipart/video),
  // then grabFrame (ffmpeg mpjpeg demuxer) for the streams. Same URL either way (grabUrl).
  const ss = (await fetchImage(cam.grabUrl)) ?? (await grabFrame(cam.grabUrl));
  if (!ss) noThumb++;
  done++;
  if (done % 50 === 0) console.log(`  …${done}/${work.length}`);
  return buildTrafficRow(toOsirisCam(cam, label), cam, ss);
});

// ── Upsert ───────────────────────────────────────────────────────────────────────

const db = openDb();
const insertMany = makeTrafficInserter(db);
const startingRows = countTrafficRows(db);
let added = 0;
let updated = 0;
let changed = 0;
try {
  const r = insertMany(rows);
  added = r.added;
  updated = r.updated;
  changed = r.changed;
} catch (err) {
  console.error(`\nMJPEG ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  let endingRows = startingRows;
  try {
    endingRows = countTrafficRows(db);
  } catch {}
  closeDb(db);

  console.log(`\n── MJPEG ingest summary ──`);
  console.log(`Cams ingested:   ${work.length}`);
  console.log(`New cams added:  ${added}`);
  console.log(`Refreshed:       ${updated} existing (${changed} with a changed thumbnail)`);
  console.log(`No thumbnail:    ${noThumb} (dead/blocked feed; placeholder card)`);
  console.log(`Traffic DB rows: ${startingRows} → ${endingRows}`);
}
