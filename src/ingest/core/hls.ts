import type { Database } from "bun:sqlite";
import { countFeedRows, feedThumbIds, makeFeedInserter } from "../../db/db.ts";
import { hlsId, parseHlsList, toHlsCam } from "../hls-source.ts";
import { buildFeedRow, classify, hasFfmpeg, snapshot } from "../osiris-source.ts";
import type { Classified, OsirisCamera } from "../../core/types.ts";
import { FeedFlusher, HLS_MAX_COOLDOWNS, HLS_TIMEOUT_ABORT, makePacer, probeReachable, tally, warnIfRateLimited, type GrabStats } from "./shared.ts";

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
  if (!ffmpeg) console.warn("ffmpeg not found: HLS cams can't be grabbed and will all be skipped (not written).");

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
      // Only persist streams we grabbed a poster for; a blank card never renders, and a
      // failed re-grab leaves any existing row (and its shot) untouched.
      if (r.snap) flusher.push(buildFeedRow(cam, classified, r.snap));
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
    console.log(`Skipped (no shot): ${stats.timeouts + stats.errors} (dead/blocked feed; not written)`);
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

