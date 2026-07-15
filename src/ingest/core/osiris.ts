import type { Database } from "bun:sqlite";
import { countFeedRows, countYtRows, feedThumbIds, makeFeedInserter, makeYtInserter } from "../../db/db.ts";
import { buildFeedRow, classifyOrReason, hasFfmpeg, snapshot, toCameras, youtubeIdOf } from "../osiris-source.ts";
import { mapLimit } from "../../core/util.ts";
import type { Classified, OsirisCamera } from "../../core/types.ts";
import { ingestYtEntries } from "./youtube.ts";
import { FeedFlusher, makePacer, tally, warnIfRateLimited, type GrabStats } from "./shared.ts";

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
  if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MP4/HLS cams can't be grabbed and will be skipped (jpg cams still work).");
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
      // Only persist cams we grabbed a shot for; a blank card never renders on the site.
      if (r.snap) flusher.push(buildFeedRow(cam, c, r.snap));
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
        const yr = await ingestYtEntries(db, ytEntries, key);
        ytAdded = yr.added;
        ytUpdated = yr.updated;
        ytMissing = yr.missing;
        ytNoThumb = yr.noThumb;
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
    console.log(`Skipped (no shot):       ${stats.timeouts + stats.errors} (dead feed / grab failed; not written)`);
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
