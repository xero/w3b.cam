// Traffic ingester: load the Osiris camera dump, classify each cam into how we
// render it (jpg/mp4/hls), snapshot a still for its gallery card, and upsert into
// the `traffic` table. Idempotent, so re-runs refresh the baked thumbnail (and
// last_seen) rather than duplicating cams. The live feed itself is not stored — the
// detail page embeds it at view time from `live_url`.
//
// YouTube cams in the dump (iframe embeds, watch/live URLs) are NOT stored here:
// they're routed to the existing youtube source (yt-api + the `youtube` table) so
// they get a real fetched thumbnail and appear in the streams gallery. That needs
// YOUTUBE_API_KEY; without it they're counted and skipped.
//
// Usage:
//   bun run traffic [file]                 (default file: in/new/osiris-cameras.json)
//   bun run traffic --limit 50             cap the number of ingestable traffic cams
//   bun run traffic --source TfL           only cams whose source contains "TfL"
//   bun run traffic --id cal-79,sin-2701   only these exact cam ids (re-scrape/hand-patch)
//   bun run traffic --concurrency 32       snapshot fan-out (default 24)
//
// Cams that need auth headers a browser can't send (ASFINAG, Fintraffic), point at
// an HTML viewer page (UDOT/511/Alberta/Ottawa), or are non-YouTube third-party
// embeds are classified out and counted, not stored (see traffic-source.ts).

import { parseArgs } from "node:util";
import { OSIRIS_JSON } from "./config.ts";
import { closeDb, countTrafficRows, countYtRows, makeTrafficInserter, makeYtInserter, openDb } from "./db.ts";
import { buildTrafficRow, classifyOrReason, hasFfmpeg, snapshot } from "./traffic-source.ts";
import { buildYtRow, extractVideoId, fetchThumbnail, fetchVideos, thumbnailUrls } from "./yt-api.ts";
import type { Classified, OsirisCamera, TrafficRow, YtRow } from "./types.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", short: "l" },
    source: { type: "string", short: "s" },
    id: { type: "string" },
    concurrency: { type: "string", short: "c" },
  },
  allowPositionals: true,
});

const file = positionals[0] ?? OSIRIS_JSON;
const limit = values.limit ? Math.max(1, Number.parseInt(values.limit, 10) || 0) : 0;
const sourceFilter = values.source?.trim().toLowerCase() || "";
const idFilter = new Set((values.id ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const concurrency = values.concurrency ? Math.max(1, Number.parseInt(values.concurrency, 10) || 0) : 24;

/** Extract the camera array from the dump: an envelope `{ cameras: [...] }`, or a bare array. */
function toCameras(parsed: unknown): OsirisCamera[] | null {
  if (Array.isArray(parsed)) return parsed as OsirisCamera[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { cameras?: unknown }).cameras)) {
    return (parsed as { cameras: OsirisCamera[] }).cameras;
  }
  return null;
}

/** True only for real YouTube hosts. Guards extractVideoId, whose /live/ and /embed/ path patterns would otherwise false-match non-YouTube stream URLs (e.g. an HLS path like …/live/gdynia_orlo…). */
function isYoutubeUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

/** The YouTube video id referenced by any of a cam's URLs, or null if it's not a YouTube cam. */
function youtubeIdOf(cam: OsirisCamera): string | null {
  for (const u of [cam.stream_url, cam.external_url, cam.feed_url]) {
    if (u && isYoutubeUrl(u)) {
      const id = extractVideoId(u);
      if (id) return id;
    }
  }
  return null;
}

/** Run `fn` over `items` with at most `n` in flight, preserving input order in the results. */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const raw = Bun.file(file);
if (!(await raw.exists())) {
  console.error(`Missing ${file}. Point me at the Osiris dump, e.g. bun run traffic in/new/osiris-cameras.json`);
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(await raw.text());
} catch (err) {
  console.error(`Could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const cameras = toCameras(parsed);
if (!cameras) {
  console.error(`Unrecognized JSON shape in ${file}: expected { cameras: [...] } or a bare array.`);
  process.exit(1);
}

// ── Classify (fast, in-memory) ──────────────────────────────────────────────────

const skips: Record<string, number> = { "auth-gated": 0, "viewer-page": 0, offsite: 0, "no-feed": 0 };
const byKind = { jpg: 0, mp4: 0, hls: 0 };
let filtered = 0;
const work: { cam: OsirisCamera; c: Classified }[] = [];

// YouTube cams (routed to the youtube table), deduped by video id, keeping the longer label.
const ytLabelById = new Map<string, string>();

for (const cam of cameras) {
  if (!cam || typeof cam.id !== "string" || cam.id === "") continue;
  if (idFilter.size && !idFilter.has(cam.id)) {
    filtered++;
    continue;
  }
  if (sourceFilter && !(cam.source ?? "").toLowerCase().includes(sourceFilter)) {
    filtered++;
    continue;
  }
  // A YouTube cam goes to the youtube source, never the traffic table.
  const ytId = youtubeIdOf(cam);
  if (ytId) {
    const label = (cam.name ?? "").trim();
    const prev = ytLabelById.get(ytId);
    if (prev === undefined || label.length > prev.length) ytLabelById.set(ytId, label);
    continue;
  }
  const r = classifyOrReason(cam);
  if (typeof r === "string") {
    skips[r] = (skips[r] ?? 0) + 1;
    continue;
  }
  byKind[r.feed_kind]++;
  work.push({ cam, c: r });
}

const ingestable = limit ? work.slice(0, limit) : work;
const ytEntries = [...ytLabelById.entries()].map(([videoId, label]) => ({ videoId, label }));

console.log(`Osiris dump: ${cameras.length.toLocaleString()} cams`);
if (sourceFilter) console.log(`Source filter "${values.source}": ${filtered.toLocaleString()} cams filtered out`);
console.log(
  `Classified: jpg ${byKind.jpg}, mp4 ${byKind.mp4}, hls ${byKind.hls}, youtube ${ytEntries.length} (→ streams) · ` +
    `deferred: auth-gated ${skips["auth-gated"]}, viewer-page ${skips["viewer-page"]}, offsite ${skips.offsite}, other ${skips["no-feed"]}`,
);
if (limit && ingestable.length < work.length) console.log(`--limit ${limit}: ingesting ${ingestable.length} of ${work.length}`);
if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MP4/HLS cams will get placeholder cards (no thumbnail).");
console.log(`Snapshotting ${ingestable.length.toLocaleString()} traffic cam(s) with concurrency ${concurrency}…`);

// ── Snapshot (bounded fan-out) + build rows ──────────────────────────────────────

let done = 0;
let noThumb = 0;
const rows = await mapLimit(ingestable, concurrency, async ({ cam, c }): Promise<TrafficRow> => {
  const ss = await snapshot(c);
  if (!ss) noThumb++;
  done++;
  if (done % 250 === 0) console.log(`  …${done}/${ingestable.length}`);
  return buildTrafficRow(cam, c, ss);
});

// ── Upsert traffic + route YouTube cams to the youtube table ─────────────────────

const db = openDb();
const insertMany = makeTrafficInserter(db);
const startingRows = countTrafficRows(db);
const startingYt = countYtRows(db);
let added = 0;
let updated = 0;
let changed = 0;
let ytAdded = 0;
let ytUpdated = 0;
let ytMissing = 0;
let ytNoThumb = 0;
let ytSkippedNoKey = 0;
try {
  const r = insertMany(rows);
  added = r.added;
  updated = r.updated;
  changed = r.changed;

  // Route YouTube cams through the existing youtube parser (yt-api → youtube table).
  if (ytEntries.length) {
    const key = process.env.YOUTUBE_API_KEY?.trim();
    if (!key) {
      ytSkippedNoKey = ytEntries.length;
    } else {
      const insertYt = makeYtInserter(db);
      const items = await fetchVideos(ytEntries.map((e) => e.videoId), key);
      const ytRows: YtRow[] = [];
      for (const e of ytEntries) {
        const item = items.get(e.videoId);
        if (!item) {
          ytMissing++;
          continue;
        }
        let ss = null;
        let usedThumbUrl: string | null = null;
        for (const u of thumbnailUrls(item)) {
          ss = await fetchThumbnail(u);
          if (ss) {
            usedThumbUrl = u;
            break;
          }
        }
        if (!ss) ytNoThumb++;
        ytRows.push(buildYtRow(e.videoId, e.label, item, usedThumbUrl, ss));
      }
      const yr = insertYt(ytRows);
      ytAdded = yr.added;
      ytUpdated = yr.updated;
    }
  }
} catch (err) {
  console.error(`\nTraffic ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  let endingRows = startingRows;
  let endingYt = startingYt;
  try {
    endingRows = countTrafficRows(db);
    endingYt = countYtRows(db);
  } catch {}
  closeDb(db);

  console.log(`\n── Traffic ingest summary ──`);
  console.log(`Ingestable traffic cams: ${ingestable.length}`);
  console.log(`New cams added:          ${added}`);
  console.log(`Refreshed:               ${updated} existing (${changed} with a changed thumbnail)`);
  console.log(`No thumbnail:            ${noThumb} (dead feed / grab failed; placeholder card)`);
  console.log(`Traffic DB rows:         ${startingRows} → ${endingRows}`);
  if (ytEntries.length) {
    console.log(`\n── YouTube cams (→ streams) ──`);
    if (ytSkippedNoKey) {
      console.log(`Found ${ytSkippedNoKey} YouTube cam(s), but YOUTUBE_API_KEY is not set — skipped.`);
      console.log(`Set the key and re-run to add them to the streams gallery.`);
    } else {
      console.log(`YouTube cams found:      ${ytEntries.length}`);
      console.log(`Added:                   ${ytAdded}, refreshed: ${ytUpdated}`);
      if (ytMissing) console.log(`Missing from API:        ${ytMissing} (deleted/private)`);
      if (ytNoThumb) console.log(`No thumbnail:            ${ytNoThumb}`);
      console.log(`YouTube DB rows:         ${startingYt} → ${endingYt}`);
    }
  }
}
