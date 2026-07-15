import type { Database } from "bun:sqlite";
import { countFeedRows, feedThumbIds, makeFeedInserter } from "../../db/db.ts";
import { classifyMjpeg, feedRank, parseMjpegList, toOsirisCam } from "../mjpeg-source.ts";
import type { MjpegClassified } from "../mjpeg-source.ts";
import { buildFeedRow, classify, hasFfmpeg, snapshot } from "../osiris-source.ts";
import { mapLimit } from "../../core/util.ts";
import { FeedFlusher, grabMjpeg, makePacer, tally, warnIfRateLimited, type GrabStats } from "./shared.ts";

// ── MJPEG (camhunt) ──────────────────────────────────────────────────────────────

interface MjpegOneReport {
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
  if (!(await hasFfmpeg())) console.warn("ffmpeg not found: MJPEG-stream cams can't be grabbed and will be skipped (jpg-snapshot cams still work).");
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
      // Only persist cams we actually grabbed a shot for: a blank card never renders on the
      // built site, so writing a screenshot-less row just pollutes the DB (an existing row's
      // good shot is preserved either way — a failed re-grab simply isn't written).
      if (r.snap) flusher.push(buildFeedRow(toOsirisCam(cam, label), cam, r.snap));
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
    console.log(`Cams processed:  ${done}`);
    console.log(`New cams added:  ${flusher.added}`);
    console.log(`Refreshed:       ${flusher.updated} existing (${flusher.changed} with a changed thumbnail)`);
    console.log(`Skipped (no shot): ${stats.timeouts + stats.errors} (dead/blocked feed; not written)`);
    console.log(`Feed DB rows: ${startingRows} → ${endingRows}`);
    warnIfRateLimited(stats);
  }
}

/** Add/refresh one MJPEG cam by URL (the dev-mode web importer). Silent; throws when no vendor rule matches. */
export async function ingestMjpegOne(db: Database, input: { url: string; label?: string }): Promise<MjpegOneReport> {
  const cam = classifyMjpeg(input.url);
  if (!cam) throw new Error("unrecognized MJPEG URL (no vendor rule matched)");
  const r = await grabMjpeg(cam.grabUrl);
  // No shot, no row: a blank card never renders, so don't write a screenshot-less cam.
  if (!r.snap) return { added: 0, updated: 0, changed: 0, noThumb: 1 };
  const row = buildFeedRow(toOsirisCam(cam, (input.label ?? "").trim()), cam, r.snap);
  const { added, updated, changed } = makeFeedInserter(db)([row]);
  return { added, updated, changed, noThumb: 0 };
}

