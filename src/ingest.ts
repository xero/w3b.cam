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
  countFeedRows,
  countYtRows,
  feedThumbIds,
  loadBlacklist,
  makeInserter,
  makeFeedInserter,
  makeYtInserter,
} from "./db.ts";
import type { InsertResult } from "./db.ts";
import { scanBanners, toBanners } from "./shodan-source.ts";
import {
  buildFeedRow,
  classify,
  classifyOrReason,
  fetchImage,
  grabFrame,
  hasFfmpeg,
  snapshot,
  toCameras,
  youtubeIdOf,
} from "./osiris-source.ts";
import { classifyMjpeg, feedRank, parseMjpegList, toOsirisCam } from "./mjpeg-source.ts";
import { hlsId, parseHlsList, toHlsCam } from "./hls-source.ts";
import type { SnapResult } from "./osiris-source.ts";
import { buildYtRow, extractVideoId, fetchThumbnail, fetchVideos, parseYoutubeList, thumbnailUrls } from "./yt-api.ts";
import { mapLimit } from "./util.ts";
import type { Classified, OsirisCamera, FeedRow, YtRow } from "./types.ts";
import type { MjpegClassified } from "./mjpeg-source.ts";
import type { YtListEntry } from "./yt-api.ts";

// ── Snapshot hardening (G1/G3/G4/G5) ──────────────────────────────────────────
// Feed ingesters that ffmpeg-grab thumbnails share three hazards a rate-limit exposes:
// a ban looks like a dead feed (G1), an all-at-once upsert loses everything on abort
// (G4), and a re-grab that fails blanks a good card (G5, in db.ts). These helpers make
// the failure reason visible, persist finished work incrementally, and warn loudly.

/** Default consecutive stream timeouts that trip the HLS circuit breaker (G3), tunable via
 *  --abort-after. A short streak of hangs is already unambiguous rate-limiting (dead feeds
 *  fail fast as errors, not timeouts, and don't count), so 5 detects the block while burning
 *  fewer requests per IP than the old 8 — the streak itself is wasted probing. */
const HLS_TIMEOUT_ABORT = 5;

/** Cap on cool-off cycles before giving up, so `--cooldown` can't loop forever against a
 *  permanent block. Each cycle sleeps `cooldownSec` then re-probes; past this we abort. */
const HLS_MAX_COOLDOWNS = 8;

/**
 * Cheap reachability check for the pre-flight probe (G2): a plain GET with a short
 * deadline. `timeout` (the hang-to-deadline signature of a block) is the only outcome
 * that matters; any HTTP response — even an error status — proves the origin is up.
 */
async function probeReachable(url: string): Promise<"ok" | "timeout" | "error"> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    return "ok";
  } catch (err) {
    return err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "error";
  }
}

/** Running tally of snapshot outcomes for one ingest (G1). */
interface GrabStats {
  ok: number;
  timeouts: number;
  errors: number;
  noFfmpeg: number;
}

/** Fold one snapshot result into the tally. */
function tally(s: GrabStats, r: SnapResult): void {
  if (r.snap) s.ok++;
  else if (r.reason === "timeout") s.timeouts++;
  else if (r.reason === "no-ffmpeg") s.noFfmpeg++;
  else s.errors++;
}

/**
 * Warn loudly when timeouts dominate the failures — the signature of a rate-limit / IP
 * block, not a batch of dead feeds (G1). G5 means the blanks were never written over
 * good cards, so the fix is simply to re-run later; say so.
 */
function warnIfRateLimited(s: GrabStats): void {
  const failed = s.timeouts + s.errors;
  if (s.timeouts >= 5 && s.timeouts >= failed * 0.5) {
    console.warn(
      `\n⚠  ${s.timeouts} snapshot(s) timed out — the origin likely rate-limited or blocked this IP\n` +
        `   (as opposed to the feeds being down). Existing thumbnails were preserved, not\n` +
        `   overwritten with blanks; re-run later (or via another IP) to fill the gaps.`,
    );
  }
}

/**
 * MJPEG's two-step grab — a plain fetch, then ffmpeg — as one SnapResult that carries the
 * failure reason (G1). Mirrors snapshot()'s jpg branch but grabs from the MJPEG-specific URL.
 */
async function grabMjpeg(grabUrl: string): Promise<SnapResult> {
  const f = await fetchImage(grabUrl);
  if (f.snap) return f;
  const g = await grabFrame(grabUrl);
  if (g.snap) return g;
  if (f.reason === "timeout" || g.reason === "timeout") return { snap: null, reason: "timeout" };
  return { snap: null, reason: g.reason ?? f.reason ?? "error" };
}

/**
 * Buffers feed rows and upserts them in batches so a run that aborts or crashes partway
 * keeps everything grabbed so far (G4) — no all-or-nothing terminal transaction. bun:sqlite
 * is synchronous, so flushing mid-fan-out never interleaves. Idempotent upsert means a later
 * re-run just refreshes; combined with G5, failed re-grabs never blank the saved cards.
 */
class FeedFlusher {
  private buf: FeedRow[] = [];
  added = 0;
  updated = 0;
  changed = 0;
  constructor(private readonly insertMany: (rows: FeedRow[]) => InsertResult, private readonly batch = 50) {}
  push(row: FeedRow): void {
    this.buf.push(row);
    if (this.buf.length >= this.batch) this.flush();
  }
  flush(): void {
    if (this.buf.length === 0) return;
    const r = this.insertMany(this.buf);
    this.added += r.added;
    this.updated += r.updated;
    this.changed += r.changed;
    this.buf = [];
  }
}

/**
 * A shared start-pacer for every ffmpeg-grabbing ingester (mjpeg / hls / osiris): returns
 * an async `pace()` that hands out monotonically spaced slots so the aggregate rate of grab
 * *starts* stays ~`delayMs` apart no matter how many workers call it — keeping a capped
 * origin from being hammered. `delayMs <= 0` makes it a no-op.
 */
function makePacer(delayMs: number): () => Promise<void> {
  let nextSlot = 0;
  return async (): Promise<void> => {
    if (delayMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + delayMs;
    if (slot > now) await Bun.sleep(slot - now);
  };
}

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
 * Ingest a curated MJPEG URL list into the shared feed table. Classifies each URL,
 * dedups to the richest rendering per physical cam, grabs a still, and upserts. Prints
 * progress + summary. Throws when the list file is missing.
 */
export async function ingestMjpegFile(
  db: Database,
  file: string,
  opts: { limit?: number; concurrency?: number; delayMs?: number; skipExisting?: boolean },
): Promise<void> {
  const limit = opts.limit ?? 0;
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 24;
  const delayMs = opts.delayMs && opts.delayMs > 0 ? opts.delayMs : 0;

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

  // --skip-existing: drop cams that already have a thumbnail (retries null placeholders).
  let pending = kept;
  let alreadyDone = 0;
  if (opts.skipExisting) {
    const have = feedThumbIds(db, kept.map((k) => k.cam.id));
    pending = kept.filter((k) => !have.has(k.cam.id));
    alreadyDone = kept.length - pending.length;
  }

  const work = limit ? pending.slice(0, limit) : pending;

  console.log(`Parsed ${entries.length} line(s): ${kept.length} unique cam(s), ${deferred} deferred (unrecognized).`);
  console.log(`By vendor: ${Object.entries(byVendor).map(([v, n]) => `${v} ${n}`).join(", ") || "none"}`);
  console.log(`Embeddable: mjpeg ${byKind.mjpeg} + jpg ${byKind.jpg}; screenshot-only: link ${byKind.link}.`);
  if (alreadyDone) console.log(`--skip-existing: ${alreadyDone} already have a thumbnail; ${pending.length} still to grab.`);
  if (limit && work.length < pending.length) console.log(`--limit ${limit}: ingesting ${work.length} of ${pending.length}`);
  if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MJPEG-stream cams will get placeholder cards (no thumbnail).");
  const paceNote = delayMs > 0 ? ` · pacing ${delayMs}ms between starts` : "";
  console.log(`Snapshotting ${work.length.toLocaleString()} cam(s) with concurrency ${concurrency}${paceNote}…`);

  // ── Snapshot (paced fan-out) → flush in batches (G4) ──────────────────────────
  const flusher = new FeedFlusher(makeFeedInserter(db));
  const startingRows = countFeedRows(db);
  const stats: GrabStats = { ok: 0, timeouts: 0, errors: 0, noFfmpeg: 0 };
  const pace = makePacer(delayMs);
  let done = 0;
  try {
    await mapLimit(work, concurrency, async ({ cam, label }): Promise<void> => {
      await pace();
      const r = await grabMjpeg(cam.grabUrl);
      tally(stats, r);
      done++;
      if (done % 50 === 0) console.log(`  …${done}/${work.length}`);
      flusher.push(buildFeedRow(toOsirisCam(cam, label), cam, r.snap));
    });
  } catch (err) {
    console.error(`\nMJPEG ingest error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    flusher.flush(); // commit whatever was grabbed, even on error (G4)
    let endingRows = startingRows;
    try {
      endingRows = countFeedRows(db);
    } catch {}
    console.log(`\n── MJPEG ingest summary ──`);
    console.log(`Cams ingested:   ${done}`);
    console.log(`New cams added:  ${flusher.added}`);
    console.log(`Refreshed:       ${flusher.updated} existing (${flusher.changed} with a changed thumbnail)`);
    console.log(`No thumbnail:    ${stats.timeouts + stats.errors} (dead/blocked feed; placeholder card)`);
    console.log(`Feed DB rows: ${startingRows} → ${endingRows}`);
    warnIfRateLimited(stats);
  }
}

/** Add/refresh one MJPEG cam by URL (the dev-mode web importer). Silent; throws when no vendor rule matches. */
export async function ingestMjpegOne(db: Database, input: { url: string; label?: string }): Promise<MjpegOneReport> {
  const cam = classifyMjpeg(input.url);
  if (!cam) throw new Error("unrecognized MJPEG URL (no vendor rule matched)");
  const r = await grabMjpeg(cam.grabUrl);
  const row = buildFeedRow(toOsirisCam(cam, (input.label ?? "").trim()), cam, r.snap);
  const { added, updated, changed } = makeFeedInserter(db)([row]);
  return { added, updated, changed, noThumb: r.snap ? 0 : 1 };
}

// ── HLS (generic; `bun import --hls`) ─────────────────────────────────────────────

/**
 * Ingest a curated list of `.m3u8` URLs as live-video feed rows (feed_kind 'hls').
 * Vendor-agnostic: any HLS playlist works, 511PA is just one source. Each line becomes
 * one row; the shared osiris classify/snapshot/buildFeedRow path does the work (ffmpeg
 * grabs the poster frame). `source` tags provenance (default "HLS"). Prints a summary.
 */
export async function ingestHlsFile(
  db: Database,
  file: string,
  opts: { source?: string; limit?: number; concurrency?: number; delayMs?: number; cooldownSec?: number; skipExisting?: boolean; abortAfter?: number },
): Promise<void> {
  const limit = opts.limit ?? 0;
  // Each frame-grab opens a real connection to the stream origin, so concurrency is
  // literally "streams viewed at once". Origins commonly cap this per-IP (511PA/arcadis
  // ban for ~1h past 8 concurrent), so default low and leave headroom — raise it only
  // for hosts you know tolerate more.
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 4;
  // Cool-off knobs (both opt-in; 0 = today's behavior). `delayMs` paces grab *starts*
  // across all workers so the aggregate request rate stays under a per-IP window limit —
  // low concurrency alone doesn't bound rate. `cooldownSec` turns the G3 abort into a
  // sleep-and-resume: on a timeout streak, pause everyone, wait, re-probe, then continue.
  const delayMs = opts.delayMs && opts.delayMs > 0 ? opts.delayMs : 0;
  const cooldownSec = opts.cooldownSec && opts.cooldownSec > 0 ? opts.cooldownSec : 0;
  // Consecutive timeouts that trip the circuit breaker (G3). Lower = fewer wasted requests
  // detecting a block, at a slightly higher chance of a false trip on genuinely slow feeds.
  const abortAfter = opts.abortAfter && opts.abortAfter > 0 ? opts.abortAfter : HLS_TIMEOUT_ABORT;
  const source = opts.source?.trim() || "HLS";

  const raw = Bun.file(file);
  if (!(await raw.exists())) {
    throw new Error(`Missing ${file}. Add one .m3u8 URL per line, or pass a path, e.g. bun import --hls in/streams.md`);
  }

  // ── Parse + classify + dedup by id (keep the longest label) ──────────────────
  const entries = parseHlsList(await raw.text());
  const byId = new Map<string, { cam: OsirisCamera; classified: Classified }>();
  let skipped = 0;
  for (const e of entries) {
    let u: URL;
    try {
      u = new URL(e.url);
    } catch {
      skipped++;
      continue;
    }
    const id = hlsId(u);
    const cam = toHlsCam(e, id, source);
    const classified = classify(cam);
    if (!classified) {
      skipped++;
      continue;
    }
    const prev = byId.get(id);
    if (!prev) byId.set(id, { cam, classified });
    else if ((cam.name?.length ?? 0) > (prev.cam.name?.length ?? 0)) prev.cam = cam;
  }

  const kept = [...byId.values()];

  // --skip-existing: drop streams that already have a thumbnail so a per-IP re-run spends
  // its limited request budget only on the gaps. Null-thumbnail placeholders (blocked/dead
  // last time) are kept and retried — feedThumbIds only matches non-null screenshots.
  let pending = kept;
  let alreadyDone = 0;
  if (opts.skipExisting) {
    const have = feedThumbIds(db, kept.map((k) => k.cam.id));
    pending = kept.filter((k) => !have.has(k.cam.id));
    alreadyDone = kept.length - pending.length;
  }

  const work = limit ? pending.slice(0, limit) : pending;

  console.log(`Parsed ${entries.length} HLS line(s): ${kept.length} unique stream(s)${skipped ? `, ${skipped} skipped` : ""}.`);
  if (alreadyDone) console.log(`--skip-existing: ${alreadyDone} already have a thumbnail; ${pending.length} still to grab.`);
  if (limit && work.length < pending.length) console.log(`--limit ${limit}: ingesting ${work.length} of ${pending.length}`);
  if (work.length === 0) {
    console.log(alreadyDone ? "Nothing to grab — every stream already has a thumbnail." : "Nothing to grab.");
    return;
  }
  const ffmpeg = await hasFfmpeg();
  if (!ffmpeg) console.warn("ffmpeg not found: HLS cams will get placeholder cards (no thumbnail).");

  // ── G2: pre-flight probe ──────────────────────────────────────────────────────
  // Stream origins cap concurrent viewers per-IP; hitting a wall of timeouts means we
  // are blocked. A cheap HTTP GET of up to two playlist URLs (8s each) tells an already-
  // banned IP apart in seconds, instead of grinding the whole list into blank cards.
  if (work.length > 0) {
    let probes = 0;
    let probeTimeouts = 0;
    for (const { classified } of work.slice(0, 2)) {
      probes++;
      if ((await probeReachable(classified.live_url)) === "timeout") probeTimeouts++;
      else break; // a response (even an error status) means the origin is reachable — proceed
    }
    if (probes > 0 && probeTimeouts === probes) {
      console.error(
        `\n⛔ Pre-flight: ${probeTimeouts}/${probes} probe stream(s) timed out — the origin is\n` +
          `   unreachable or rate-limiting this IP. Aborting before ${work.length} grabs.\n` +
          `   Wait out the cooldown (511PA/arcadis ~1h) or switch IP, then re-run.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const paceNote = delayMs > 0 ? ` · pacing ${delayMs}ms between starts` : "";
  const coolNote = cooldownSec > 0 ? ` · cool-off ${cooldownSec}s ×${HLS_MAX_COOLDOWNS}` : "";
  console.log(`Snapshotting ${work.length.toLocaleString()} stream(s) with concurrency ${concurrency}${paceNote}${coolNote}…`);

  // ── Snapshot (paced fan-out) → flush in batches (G4); on a timeout streak either
  //    cool off and resume, or abort (G3) ──────────────────────────────────────────
  const flusher = new FeedFlusher(makeFeedInserter(db));
  const startingRows = countFeedRows(db);
  const stats: GrabStats = { ok: 0, timeouts: 0, errors: 0, noFfmpeg: 0 };
  let done = 0;
  let streak = 0; // consecutive timeouts
  let aborted = false;
  let cooldowns = 0;
  let idx = 0;
  let cooling: Promise<void> | null = null; // single-flighted pause shared by all workers
  const pace = makePacer(delayMs);

  // On a timeout streak with a cooldown budget: pause every worker, sleep, and re-probe
  // until the origin answers (or the budget runs out). Finished rows are already flushed
  // (G4), so resuming just fills the gaps. Single-flighted: concurrent trips join one pause.
  const startCooldown = (): void => {
    if (cooling) return;
    cooling = (async () => {
      // Persist everything grabbed so far before the long sleep (G4): a kill during a
      // cool-off must not lose the buffered rows, and "saved so far" below must be true.
      flusher.flush();
      for (;;) {
        cooldowns++;
        console.warn(
          `\n🧊 Cooling off ${cooldownSec}s (cycle ${cooldowns}/${HLS_MAX_COOLDOWNS}) — ` +
            `${done}/${work.length} grabbed, ${flusher.added + flusher.updated} saved so far…`,
        );
        await Bun.sleep(cooldownSec * 1000);
        if ((await probeReachable(work[0]!.classified.live_url)) !== "timeout") break; // origin is back
        if (cooldowns >= HLS_MAX_COOLDOWNS) {
          aborted = true;
          break;
        }
      }
      streak = 0;
      cooling = null;
    })();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      if (cooling) await cooling; // pause during a cool-off window
      if (aborted) return;
      const i = idx++;
      if (i >= work.length) return;
      await pace();
      if (aborted) return;
      const { cam, classified } = work[i]!;
      const r = await snapshot(classified);
      tally(stats, r);
      if (r.reason === "timeout") {
        streak++;
        if (streak >= abortAfter) {
          if (cooldownSec > 0 && cooldowns < HLS_MAX_COOLDOWNS) startCooldown();
          else aborted = true;
        }
      } else {
        streak = 0;
      }
      done++;
      if (done % 50 === 0) console.log(`  …${done}/${work.length}`);
      flusher.push(buildFeedRow(cam, classified, r.snap));
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  } catch (err) {
    console.error(`\nHLS ingest error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    flusher.flush(); // commit everything grabbed so far (G4)
    let endingRows = startingRows;
    try {
      endingRows = countFeedRows(db);
    } catch {}
    console.log(`\n── HLS ingest summary ──`);
    console.log(`Streams grabbed:  ${done}${done < work.length ? ` of ${work.length}` : ""}`);
    console.log(`New cams added:   ${flusher.added}`);
    console.log(`Refreshed:        ${flusher.updated} existing (${flusher.changed} with a changed thumbnail)`);
    console.log(`No thumbnail:     ${stats.timeouts + stats.errors} (dead/blocked feed; placeholder card)`);
    if (cooldowns > 0) console.log(`Cool-off cycles:  ${cooldowns}`);
    console.log(`Feed DB rows: ${startingRows} → ${endingRows}`);
    if (aborted) {
      const exhausted = cooldowns >= HLS_MAX_COOLDOWNS;
      console.error(
        `\n⛔ Aborted: ${exhausted ? `origin still blocking after ${cooldowns} cool-off cycle(s)` : `${abortAfter} consecutive stream timeouts`} —\n` +
          `   you appear to be rate-limited / IP-blocked by the origin (511PA/arcadis bans ~1h\n` +
          `   past their concurrent-stream cap). ${done} of ${work.length} grabbed and saved — re-run\n` +
          `   later (or via another IP) to resume; the idempotent upsert fills the gaps and never\n` +
          `   blanks the cards already stored.${cooldownSec === 0 ? " Tip: add --cooldown <sec> to sleep-and-resume instead." : ""}`,
      );
      process.exitCode = 1;
    } else {
      warnIfRateLimited(stats);
    }
  }
}

// ── Osiris (internal; `bun run osiris`) ──────────────────────────────────────────

/**
 * Ingest the Osiris camera dump into the feed table (refreshing baked thumbnails),
 * routing any YouTube cams out to the youtube table. `ytKey` is optional: without it,
 * YouTube cams are counted and skipped (never fatal). Prints progress + summary.
 * Throws on a missing/unparseable file.
 */
export async function ingestOsirisFile(
  db: Database,
  file: string,
  opts: { limit?: number; source?: string; id?: string; concurrency?: number; ytKey?: string; delayMs?: number; skipExisting?: boolean },
): Promise<void> {
  const limit = opts.limit ?? 0;
  const sourceFilter = opts.source?.trim().toLowerCase() || "";
  const idFilter = new Set((opts.id ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 24;
  const delayMs = opts.delayMs && opts.delayMs > 0 ? opts.delayMs : 0;

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

  // --skip-existing: drop cams that already have a thumbnail (retries null placeholders).
  let pending = work;
  let alreadyDone = 0;
  if (opts.skipExisting) {
    const have = feedThumbIds(db, work.map((w) => w.cam.id));
    pending = work.filter((w) => !have.has(w.cam.id));
    alreadyDone = work.length - pending.length;
  }

  const ingestable = limit ? pending.slice(0, limit) : pending;
  const ytEntries = [...ytLabelById.entries()].map(([videoId, label]) => ({ videoId, label }));

  console.log(`Osiris dump: ${cameras.length.toLocaleString()} cams`);
  if (sourceFilter) console.log(`Source filter "${opts.source}": ${filtered.toLocaleString()} cams filtered out`);
  console.log(
    `Classified: jpg ${byKind.jpg}, mp4 ${byKind.mp4}, hls ${byKind.hls}, youtube ${ytEntries.length} (→ streams) · ` +
      `deferred: auth-gated ${skips["auth-gated"]}, viewer-page ${skips["viewer-page"]}, offsite ${skips.offsite}, other ${skips["no-feed"]}`,
  );
  if (alreadyDone) console.log(`--skip-existing: ${alreadyDone} already have a thumbnail; ${pending.length} still to grab.`);
  if (limit && ingestable.length < pending.length) console.log(`--limit ${limit}: ingesting ${ingestable.length} of ${pending.length}`);
  if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MP4/HLS cams will get placeholder cards (no thumbnail).");
  const paceNote = delayMs > 0 ? ` · pacing ${delayMs}ms between starts` : "";
  console.log(`Snapshotting ${ingestable.length.toLocaleString()} feed cam(s) with concurrency ${concurrency}${paceNote}…`);

  // ── Snapshot (paced fan-out) → flush feed rows in batches (G4) ─────────────────
  const flusher = new FeedFlusher(makeFeedInserter(db));
  const startingRows = countFeedRows(db);
  const startingYt = countYtRows(db);
  const stats: GrabStats = { ok: 0, timeouts: 0, errors: 0, noFfmpeg: 0 };
  const pace = makePacer(delayMs);
  let done = 0;
  try {
    await mapLimit(ingestable, concurrency, async ({ cam, c }): Promise<void> => {
      await pace();
      const r = await snapshot(c);
      tally(stats, r);
      done++;
      if (done % 250 === 0) console.log(`  …${done}/${ingestable.length}`);
      flusher.push(buildFeedRow(cam, c, r.snap));
    });
  } finally {
    flusher.flush(); // finished feed grabs persist even if YouTube routing throws (G4)
  }

  // ── Route YouTube cams to the youtube table ───────────────────────────────────
  const added = flusher.added;
  const updated = flusher.updated;
  const changed = flusher.changed;
  let ytAdded = 0;
  let ytUpdated = 0;
  let ytMissing = 0;
  let ytNoThumb = 0;
  let ytSkippedNoKey = 0;
  try {
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
    console.error(`\nFeeds ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    let endingRows = startingRows;
    let endingYt = startingYt;
    try {
      endingRows = countFeedRows(db);
      endingYt = countYtRows(db);
    } catch {}

    console.log(`\n── Feed ingest summary ──`);
    console.log(`Ingestable feed cams: ${ingestable.length}`);
    console.log(`New cams added:          ${added}`);
    console.log(`Refreshed:               ${updated} existing (${changed} with a changed thumbnail)`);
    console.log(`No thumbnail:            ${stats.timeouts + stats.errors} (dead feed / grab failed; placeholder card)`);
    console.log(`Feed DB rows:         ${startingRows} → ${endingRows}`);
    warnIfRateLimited(stats);
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
