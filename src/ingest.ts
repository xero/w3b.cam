// Shared ingest core. One import surface for the CLI dispatcher (src/import.ts),
// the internal Osiris CLI (src/osiris.ts), and the dev-mode web importer
// (src/dev.ts). Every function takes an open `db` and NEVER opens/closes a DB,
// parses argv, or exits — the executable entrypoints own all of that.
//
// Two flavors per source:
//   * bulk `ingest*File`/`Dir` — read a file/dir, print progress + summary, and
//     upsert (the CLI path; behavior mirrors the old standalone scripts).
//   * single `ingest*One`/`Text` — silent, return a tally, and THROW on bad input
//     so the web handler can map failures to an HTTP status + error toast.

import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import {
  countRows,
  countTrafficRows,
  countYtRows,
  loadBlacklist,
  makeInserter,
  makeTrafficInserter,
  makeYtInserter,
} from "./db.ts";
import { scanBanners, toBanners } from "./shodan-source.ts";
import {
  buildTrafficRow,
  classifyOrReason,
  fetchImage,
  grabFrame,
  hasFfmpeg,
  snapshot,
  toCameras,
  youtubeIdOf,
} from "./traffic-source.ts";
import { classifyMjpeg, feedRank, parseMjpegList, toOsirisCam } from "./mjpeg-source.ts";
import { buildYtRow, extractVideoId, fetchThumbnail, fetchVideos, parseYoutubeList, thumbnailUrls } from "./yt-api.ts";
import { mapLimit } from "./util.ts";
import type { Classified, OsirisCamera, TrafficRow, YtRow } from "./types.ts";
import type { MjpegClassified } from "./mjpeg-source.ts";
import type { YtListEntry } from "./yt-api.ts";

// ── Shodan ────────────────────────────────────────────────────────────────────

/** Silent single-file/paste result (also the shape the web toast reads). */
export interface ShodanReport {
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

// ── YouTube ─────────────────────────────────────────────────────────────────────

export interface YtReport {
  added: number;
  updated: number;
  changed: number;
  requested: number;
  missing: number;
  noThumb: number;
}

/** Fetch metadata + thumbnails for a set of entries and upsert them. Silent unless `verbose`. */
async function ingestYtEntries(db: Database, entries: YtListEntry[], key: string, verbose = false): Promise<YtReport> {
  const items = await fetchVideos(entries.map((e) => e.videoId), key);
  const rows: YtRow[] = [];
  let missing = 0;
  let noThumb = 0;
  for (const entry of entries) {
    const item = items.get(entry.videoId);
    if (!item) {
      missing++;
      if (verbose) console.warn(`  ${entry.videoId}: not returned by API (deleted/private?), skipping`);
      continue;
    }
    // Try thumbnail sizes best-first; keep the first that actually fetches.
    let ss = null;
    let usedThumbUrl: string | null = null;
    for (const u of thumbnailUrls(item)) {
      ss = await fetchThumbnail(u);
      if (ss) {
        usedThumbUrl = u;
        break;
      }
    }
    if (!ss) {
      noThumb++;
      if (verbose) console.warn(`  ${entry.videoId}: no thumbnail captured`);
    }
    rows.push(buildYtRow(entry.videoId, entry.label, item, usedThumbUrl, ss));
  }
  const { added, updated, changed } = makeYtInserter(db)(rows);
  return { added, updated, changed, requested: entries.length, missing, noThumb };
}

/**
 * Ingest YouTube streams from either a curated file or a single URL, into the youtube
 * table. Prints progress + summary. Throws (missing file / bad url) for the dispatcher.
 */
export async function ingestYoutube(
  db: Database,
  source: { file: string; limit?: number } | { url: string; label?: string },
  key: string,
): Promise<void> {
  let entries: YtListEntry[];
  let sourceDesc: string;

  if ("url" in source) {
    const videoId = extractVideoId(source.url);
    if (!videoId) throw new Error(`Could not extract a video id from: ${source.url} (expected a watch?v=, youtu.be/, or /live/ URL)`);
    entries = [{ videoId, label: (source.label ?? "").trim() }];
    sourceDesc = `--url (${videoId})`;
  } else {
    const file = Bun.file(source.file);
    if (!(await file.exists())) {
      throw new Error(`Missing ${source.file}. Add one line per stream as "title <url>", or pass --url <url> to add a single one.`);
    }
    entries = parseYoutubeList(await file.text());
    if (entries.length === 0) {
      console.log(`No YouTube URLs found in ${source.file}.`);
      return;
    }
    if (source.limit) entries = entries.slice(0, source.limit);
    sourceDesc = `${source.file}${source.limit ? ` (limited to ${source.limit})` : ""}`;
  }

  console.log(`Ingesting ${entries.length} stream(s) from ${sourceDesc}.`);
  const startingRows = countYtRows(db);
  let rep: YtReport | undefined;
  try {
    rep = await ingestYtEntries(db, entries, key, true);
  } catch (err) {
    console.error(`\nYouTube ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    const endingRows = countYtRows(db);
    console.log(`\n── Summary ──`);
    console.log(`Streams requested: ${entries.length}`);
    console.log(`New streams added: ${rep?.added ?? 0}`);
    console.log(`Refreshed:         ${rep?.updated ?? 0} existing (${rep?.changed ?? 0} with a changed thumbnail)`);
    if (rep?.missing) console.log(`Missing from API:  ${rep.missing}`);
    if (rep?.noThumb) console.log(`No thumbnail:      ${rep.noThumb}`);
    console.log(`DB rows:           ${startingRows} → ${endingRows}`);
  }
}

/** Add/refresh one stream by URL (the dev-mode web importer). Silent; throws on a bad URL. */
export async function ingestYoutubeOne(db: Database, input: { url: string; label?: string }, key: string): Promise<YtReport> {
  const videoId = extractVideoId(input.url);
  if (!videoId) throw new Error("could not extract a video id (expected a watch?v=, youtu.be/, or /live/ URL)");
  return ingestYtEntries(db, [{ videoId, label: (input.label ?? "").trim() }], key);
}

// ── MJPEG (camhunt) ──────────────────────────────────────────────────────────────

export interface MjpegOneReport {
  added: number;
  updated: number;
  changed: number;
  noThumb: number;
}

/**
 * Ingest a curated MJPEG URL list into the shared traffic table. Classifies each URL,
 * dedups to the richest rendering per physical cam, grabs a still, and upserts. Prints
 * progress + summary. Throws when the list file is missing.
 */
export async function ingestMjpegFile(db: Database, file: string, opts: { limit?: number; concurrency?: number }): Promise<void> {
  const limit = opts.limit ?? 0;
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 24;

  const raw = Bun.file(file);
  if (!(await raw.exists())) {
    throw new Error(`Missing ${file}. Add one URL per line, or pass a path, e.g. bun import --mjpeg in/mjpeg.md`);
  }

  // ── Parse + classify + dedup (fast, in-memory) ───────────────────────────────
  const entries = parseMjpegList(await raw.text());

  // Dedup by id, keeping the richest rendering of a physical cam (mjpeg > jpg > link)
  // and the longest label seen.
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

  // ── Snapshot (bounded fan-out) + build rows ──────────────────────────────────
  let done = 0;
  let noThumb = 0;
  const rows = await mapLimit(work, concurrency, async ({ cam, label }): Promise<TrafficRow> => {
    const ss = (await fetchImage(cam.grabUrl)) ?? (await grabFrame(cam.grabUrl));
    if (!ss) noThumb++;
    done++;
    if (done % 50 === 0) console.log(`  …${done}/${work.length}`);
    return buildTrafficRow(toOsirisCam(cam, label), cam, ss);
  });

  // ── Upsert ────────────────────────────────────────────────────────────────────
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
    console.log(`\n── MJPEG ingest summary ──`);
    console.log(`Cams ingested:   ${work.length}`);
    console.log(`New cams added:  ${added}`);
    console.log(`Refreshed:       ${updated} existing (${changed} with a changed thumbnail)`);
    console.log(`No thumbnail:    ${noThumb} (dead/blocked feed; placeholder card)`);
    console.log(`Traffic DB rows: ${startingRows} → ${endingRows}`);
  }
}

/** Add/refresh one MJPEG cam by URL (the dev-mode web importer). Silent; throws when no vendor rule matches. */
export async function ingestMjpegOne(db: Database, input: { url: string; label?: string }): Promise<MjpegOneReport> {
  const cam = classifyMjpeg(input.url);
  if (!cam) throw new Error("unrecognized MJPEG URL (no vendor rule matched)");
  const ss = (await fetchImage(cam.grabUrl)) ?? (await grabFrame(cam.grabUrl));
  const row = buildTrafficRow(toOsirisCam(cam, (input.label ?? "").trim()), cam, ss);
  const { added, updated, changed } = makeTrafficInserter(db)([row]);
  return { added, updated, changed, noThumb: ss ? 0 : 1 };
}

// ── Osiris (internal; `bun run osiris`) ──────────────────────────────────────────

/**
 * Ingest the Osiris camera dump into the traffic table (refreshing baked thumbnails),
 * routing any YouTube cams out to the youtube table. `ytKey` is optional: without it,
 * YouTube cams are counted and skipped (never fatal). Prints progress + summary.
 * Throws on a missing/unparseable file.
 */
export async function ingestOsirisFile(
  db: Database,
  file: string,
  opts: { limit?: number; source?: string; id?: string; concurrency?: number; ytKey?: string },
): Promise<void> {
  const limit = opts.limit ?? 0;
  const sourceFilter = opts.source?.trim().toLowerCase() || "";
  const idFilter = new Set((opts.id ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 24;

  const raw = Bun.file(file);
  if (!(await raw.exists())) {
    throw new Error(`Missing ${file}. Point me at the Osiris dump, e.g. bun run osiris in/new/osiris-cameras.json`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await raw.text());
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const cameras = toCameras(parsed);
  if (!cameras) {
    throw new Error(`Unrecognized JSON shape in ${file}: expected { cameras: [...] } or a bare array.`);
  }

  // ── Classify (fast, in-memory) ────────────────────────────────────────────────
  const skips: Record<string, number> = { "auth-gated": 0, "viewer-page": 0, offsite: 0, "no-feed": 0 };
  const byKind = { jpg: 0, mp4: 0, hls: 0, mjpeg: 0, link: 0 };
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
  if (sourceFilter) console.log(`Source filter "${opts.source}": ${filtered.toLocaleString()} cams filtered out`);
  console.log(
    `Classified: jpg ${byKind.jpg}, mp4 ${byKind.mp4}, hls ${byKind.hls}, youtube ${ytEntries.length} (→ streams) · ` +
      `deferred: auth-gated ${skips["auth-gated"]}, viewer-page ${skips["viewer-page"]}, offsite ${skips.offsite}, other ${skips["no-feed"]}`,
  );
  if (limit && ingestable.length < work.length) console.log(`--limit ${limit}: ingesting ${ingestable.length} of ${work.length}`);
  if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MP4/HLS cams will get placeholder cards (no thumbnail).");
  console.log(`Snapshotting ${ingestable.length.toLocaleString()} traffic cam(s) with concurrency ${concurrency}…`);

  // ── Snapshot (bounded fan-out) + build rows ──────────────────────────────────
  let done = 0;
  let noThumb = 0;
  const rows = await mapLimit(ingestable, concurrency, async ({ cam, c }): Promise<TrafficRow> => {
    const ss = await snapshot(c);
    if (!ss) noThumb++;
    done++;
    if (done % 250 === 0) console.log(`  …${done}/${ingestable.length}`);
    return buildTrafficRow(cam, c, ss);
  });

  // ── Upsert traffic + route YouTube cams to the youtube table ─────────────────
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

    // Route YouTube cams through the youtube parser (yt-api → youtube table).
    if (ytEntries.length) {
      const key = opts.ytKey?.trim();
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
}
