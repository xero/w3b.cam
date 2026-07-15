// Snapshot-hardening helpers shared by the feed ingesters (mjpeg / hls / osiris): the
// reachability probe, the grab tally + rate-limit warning, the MJPEG two-step grab, the
// incremental batch flusher, and the start-pacer. Internal — the barrel does not re-export.
import type { InsertResult } from "../../db/db.ts";
import { fetchImage, grabFrame } from "../osiris-source.ts";
import type { SnapResult } from "../osiris-source.ts";
import type { FeedRow } from "../../core/types.ts";

// ── Snapshot hardening (G1/G3/G4/G5) ──────────────────────────────────────────
// Feed ingesters that ffmpeg-grab thumbnails share three hazards a rate-limit exposes:
// a ban looks like a dead feed (G1), an all-at-once upsert loses everything on abort
// (G4), and a re-grab that fails blanks a good card (G5, in db.ts). These helpers make
// the failure reason visible, persist finished work incrementally, and warn loudly.

/** Default consecutive stream timeouts that trip the HLS circuit breaker (G3), tunable via
 *  --abort-after. A short streak of hangs is already unambiguous rate-limiting (dead feeds
 *  fail fast as errors, not timeouts, and don't count), so 5 detects the block while burning
 *  fewer requests per IP than the old 8 — the streak itself is wasted probing. */
export const HLS_TIMEOUT_ABORT = 5;

/** Cap on cool-off cycles before giving up, so `--cooldown` can't loop forever against a
 *  permanent block. Each cycle sleeps `cooldownSec` then re-probes; past this we abort. */
export const HLS_MAX_COOLDOWNS = 8;

/**
 * Cheap reachability check for the pre-flight probe (G2): a plain GET with a short
 * deadline. `timeout` (the hang-to-deadline signature of a block) is the only outcome
 * that matters; any HTTP response — even an error status — proves the origin is up.
 */
export async function probeReachable(url: string): Promise<"ok" | "timeout" | "error"> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000), redirect: "follow" });
    return "ok";
  } catch (err) {
    return err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "error";
  }
}

/** Running tally of snapshot outcomes for one ingest (G1). */
export interface GrabStats {
  ok: number;
  timeouts: number;
  errors: number;
  noFfmpeg: number;
}

/** Fold one snapshot result into the tally. */
export function tally(s: GrabStats, r: SnapResult): void {
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
export function warnIfRateLimited(s: GrabStats): void {
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
export async function grabMjpeg(grabUrl: string): Promise<SnapResult> {
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
export class FeedFlusher {
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
export function makePacer(delayMs: number): () => Promise<void> {
  let nextSlot = 0;
  return async (): Promise<void> => {
    if (delayMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + delayMs;
    if (slot > now) await Bun.sleep(slot - now);
  };
}
