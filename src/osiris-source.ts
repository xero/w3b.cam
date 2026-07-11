// Osiris "feed" source: classify each raw camera into how we render it, and
// snapshot a still for its gallery card. Native fetch for JPEG feeds; ffmpeg for a
// single frame off MP4/HLS streams. No new runtime dependency (ffmpeg is a system
// binary, probed once and treated as optional — a missing/failed grab just yields
// a placeholder card).
//
// The classifier is deliberately conservative: it stores only cams we can render
// in v1 (open direct-image JPEGs, MP4/HLS video, and iframe/external link-outs) and
// returns null for anything that needs auth headers a browser can't send (ASFINAG
// Basic, Fintraffic Digitraffic-User) or points at an HTML viewer page rather than
// an image (UDOT/511/Alberta/Ottawa). Those are deferred to a later pass.

import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractVideoId } from "./yt-api.ts";
import type { Classified, OsirisCamera, FeedRow } from "./types.ts";

/** A captured still: base64 bytes, mime, and a sha256 hex of the bytes (change detection). */
export interface Snapshot {
  data: string;
  mime: string;
  hash: string;
}

/**
 * Why a snapshot failed (G1). `timeout` is the important one: a connection that hangs
 * to the deadline is the signature of a rate-limit / IP block (a dead feed refuses or
 * 404s fast, an undecodable one errors fast). Ingesters use a run of `timeout`s to tell
 * "we got banned" from "these feeds are just down". `null` reason ⇔ a real snapshot.
 */
export type SnapFail = "timeout" | "error" | "no-ffmpeg";

/** A snapshot attempt: the still (on success) or the reason it failed (G1). */
export interface SnapResult {
  snap: Snapshot | null;
  reason: SnapFail | null;
}

/** Wrap a captured still as a successful SnapResult. */
const ok = (snap: Snapshot): SnapResult => ({ snap, reason: null });
/** A failed SnapResult carrying why. */
const fail = (reason: SnapFail): SnapResult => ({ snap: null, reason });

/**
 * A browser-like User-Agent. Several public/government cam endpoints (e.g. NSW Live
 * Feed) serve a block/redirect HTML page to header-less clients but the real
 * image to a browser, so we present one when snapshotting. A real browser sends its
 * own UA for the live <img>, so this only matters for the server-side ingest.
 */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── Classification ─────────────────────────────────────────────────────────────

/** Viewer/redirect pages and the one broken curated API endpoint — not images, deferred. */
const VIEWER_PAGE = /\/map\/|\/api\/v2\/get\/cameras/i;
/** Endpoints that return an image only with an auth header a browser <img> can't send — deferred. */
const AUTH_GATED = /asfinag\.at|CamPicServlet|digitraffic\.fi/i;
/** A URL that ends in an image extension (query/hash tolerated). */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i;
/** A CGI/servlet path that returns an image despite having no extension (e.g. Axis cams). */
const IMAGE_ENDPOINT = /image\.cgi|axis-cgi/i;

/** True when a URL is expected to return image bytes directly (by extension or known endpoint). */
function isImageUrl(u: string): boolean {
  return IMAGE_EXT.test(u) || IMAGE_ENDPOINT.test(u);
}

/**
 * Decide how a camera renders in the feeds gallery, or return null to skip it.
 * Only embeddable live feeds are kept (direct-image JPEGs and MP4/HLS video);
 * auth-gated, viewer-page, and third-party-embed cams are skipped. YouTube cams
 * are handled separately by the ingester (routed to the youtube table), so they
 * never reach classify. `live_url` is the URL the detail page embeds; `external_url`
 * is an optional human-facing viewer page.
 */
export function classify(cam: OsirisCamera): Classified | null {
  const type = (cam.stream_type ?? "").toLowerCase();
  const stream = cam.stream_url?.trim() || null;
  const feed = cam.feed_url?.trim() || null;
  const ext = cam.external_url?.trim() || null;

  // 1. An explicit stream_type wins — the live video cams we can embed.
  if (stream) {
    if (type === "mp4") return { feed_kind: "mp4", live_url: stream, external_url: ext };
    if (type === "hls") return { feed_kind: "hls", live_url: stream, external_url: ext };
    if (type === "jpg") return { feed_kind: "jpg", live_url: stream, external_url: ext };
    // iframe embeds are never loaded into our DOM — skip (YouTube handled upstream).
  }

  // 2. A snapshot feed_url: keep only open, direct images.
  if (feed) {
    if (VIEWER_PAGE.test(feed) || AUTH_GATED.test(feed)) return null; // deferred
    if (isImageUrl(feed)) return { feed_kind: "jpg", live_url: feed, external_url: ext };
    return null; // unknown/non-image endpoint → defer
  }

  return null;
}

/** Why a camera was skipped, for the ingest summary. */
export type SkipReason = "auth-gated" | "viewer-page" | "offsite" | "no-feed";

/**
 * Classify, or report why the cam is skipped. Splits the null cases classify()
 * collapses so the ingester can tally deferred cams by reason. Called only for
 * non-YouTube cams (the ingester routes YouTube ones out first), so an iframe or
 * external-only cam here is a non-YouTube "offsite" feed.
 */
export function classifyOrReason(cam: OsirisCamera): Classified | SkipReason {
  const c = classify(cam);
  if (c) return c;
  const feed = cam.feed_url?.trim() || null;
  if (feed && AUTH_GATED.test(feed)) return "auth-gated";
  if (feed && VIEWER_PAGE.test(feed)) return "viewer-page";
  if ((cam.stream_type ?? "").toLowerCase() === "iframe" || (cam.external_url?.trim() ?? "") !== "") return "offsite";
  return "no-feed";
}

// ── Osiris dump shape + YouTube routing ─────────────────────────────────────────

/** Extract the camera array from the dump: an envelope `{ cameras: [...] }`, or a bare array. */
export function toCameras(parsed: unknown): OsirisCamera[] | null {
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
export function youtubeIdOf(cam: OsirisCamera): string | null {
  for (const u of [cam.stream_url, cam.external_url, cam.feed_url]) {
    if (u && isYoutubeUrl(u)) {
      const id = extractVideoId(u);
      if (id) return id;
    }
  }
  return null;
}

// ── Snapshotting ─────────────────────────────────────────────────────────────

/**
 * Identify an image by its magic bytes, or null if the bytes aren't a known image.
 * We sniff rather than trust Content-Type because cam endpoints routinely mislabel
 * (e.g. LTA Singapore serves JPEGs as application/octet-stream), and a block/redirect
 * HTML page won't match any signature so it's rejected cleanly.
 */
function sniffImageMime(b: Buffer): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  return null;
}

/**
 * Fetch a single-image snapshot: base64 bytes, mime (sniffed from the bytes), sha256
 * hex. Multipart/video responses are left to grabFrame (see snapshot). Returns null
 * on any failure — including Bun's stricter-than-a-browser TLS verification — so the
 * caller can fall back to ffmpeg, and a truly dead cam degrades to a placeholder card.
 */
export async function fetchImage(url: string): Promise<SnapResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "image/*,*/*" },
    });
    if (!res.ok) return fail("error");
    const ct = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (ct.startsWith("multipart/") || ct.startsWith("video/")) return fail("error"); // a stream → grabFrame handles it
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) return fail("error"); // not an image (HTML block page, etc.)
    const hash = createHash("sha256").update(buf).digest("hex");
    return ok({ data: buf.toString("base64"), mime, hash });
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError; a hang to the deadline is the
    // rate-limit signature. Everything else (refused, DNS, reset) fails fast → error.
    return fail(err instanceof DOMException && err.name === "TimeoutError" ? "timeout" : "error");
  }
}

/** Download raw bytes (browser UA, timeout-guarded). `timedOut` distinguishes a hang to
 *  the deadline (rate-limit signal) from a fast failure. Used to feed ffmpeg a whole file. */
async function downloadBytes(url: string): Promise<{ bytes: Buffer | null; timedOut: boolean }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow", headers: { "User-Agent": UA } });
    if (!res.ok) return { bytes: null, timedOut: false };
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf.length ? buf : null, timedOut: false };
  } catch (err) {
    return { bytes: null, timedOut: err instanceof DOMException && err.name === "TimeoutError" };
  }
}

/** Probe for ffmpeg once; a missing binary makes grabFrame a no-op (video cams get placeholders). */
let ffmpegAvailable: boolean | null = null;
export async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const p = Bun.spawn(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" });
    ffmpegAvailable = (await p.exited) === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

/** One ffmpeg invocation that decodes a single frame (downscaled to 640px) to a JPEG.
 *  `inputArgs` carries any protocol options plus the `-i <input>`. Returns the still, or
 *  null with `timedOut` set when the 20s kill-timer fired (the hang = rate-limit signal). */
async function ffmpegFrame(inputArgs: string[]): Promise<{ snap: Snapshot | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const proc = Bun.spawn(
      [
        "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
        ...inputArgs,
        "-frames:v", "1",
        "-vf", "scale='min(640,iw)':-2",
        "-f", "image2", "-c:v", "mjpeg",
        "pipe:1",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {}
    }, 20_000);
    const buf = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    if (buf.length === 0) return { snap: null, timedOut };
    const hash = createHash("sha256").update(buf).digest("hex");
    return { snap: { data: buf.toString("base64"), mime: "image/jpeg", hash }, timedOut };
  } catch {
    return { snap: null, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Grab a single frame from a video/stream/image URL via ffmpeg, as a downscaled JPEG.
 * Tries, in order: a direct read (the common case — MP4/HLS and images whose TLS chain
 * Bun's fetch rejects but ffmpeg accepts); the mpjpeg demuxer (Axis `image.cgi` cams
 * that return a multipart/x-mixed-replace MJPEG stream); and finally a full download to
 * a temp file (containers ffmpeg can't stream from the URL — e.g. an mp4 whose moov atom
 * is at the end and the server won't range-request — need a seekable local file). Null
 * if all fail / ffmpeg absent. `-user_agent` is only for URL inputs (it errors on a file).
 */
export async function grabFrame(url: string): Promise<SnapResult> {
  if (!(await hasFfmpeg())) return fail("no-ffmpeg");
  const direct = ["-user_agent", UA, "-i", url];
  const mpjpeg = ["-user_agent", UA, "-f", "mpjpeg", "-i", url];
  // Axis image.cgi / mjpeg endpoints stream multipart and often allow only one
  // connection, so a failed direct read can hold it and block the retry. Try the
  // mpjpeg demuxer first for those; everything else reads directly first (no wasted
  // attempt for the 748 MP4/HLS cams). axis-cgi/media.cgi is the exception: it is an
  // h264/mp4 stream, not multipart MJPEG, so it must read directly first.
  const mjpegLikely = /image\.cgi|mjpe?g/i.test(url) || (/axis-cgi/i.test(url) && !/media\.cgi/i.test(url));
  const order = mjpegLikely ? [mpjpeg, direct] : [direct, mpjpeg];

  // A hang to the deadline means the endpoint is unreachable/blocked, so the other
  // demuxer attempts (and the download fallback) would just hang too — bail immediately
  // and report `timeout`. This keeps a rate-limited grab ~20s instead of ~55s, which the
  // HLS circuit breaker relies on to trip quickly.
  for (const args of order) {
    const r = await ffmpegFrame(args);
    if (r.snap) return ok(r.snap);
    if (r.timedOut) return fail("timeout");
  }
  // Last resort: download the whole container to a seekable temp file (an mp4 whose
  // moov atom is at the end can't be decoded from a non-seekable HTTP stream).
  const dl = await downloadBytes(url);
  if (dl.timedOut) return fail("timeout");
  if (dl.bytes) {
    const tmp = `${tmpdir()}/feed-frame-${Date.now()}-${Math.round(Math.random() * 1e9)}.bin`;
    try {
      await Bun.write(tmp, dl.bytes);
      const r = await ffmpegFrame(["-i", tmp]);
      if (r.snap) return ok(r.snap);
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  // Reached here only via fast failures (no timeout short-circuited above).
  return fail("error");
}

/**
 * Capture the card thumbnail for a classified cam. JPEG cams try a plain fetch first
 * (fast, no subprocess) and fall back to ffmpeg, which recovers the awkward ones
 * (mislabeled content-types, broken TLS chains, MJPEG streams). MP4/HLS go straight
 * to ffmpeg.
 */
export async function snapshot(c: Classified): Promise<SnapResult> {
  switch (c.feed_kind) {
    case "jpg": {
      const f = await fetchImage(c.live_url);
      if (f.snap) return f;
      const g = await grabFrame(c.live_url);
      if (g.snap) return g;
      // Neither worked: a timeout from either attempt is the signal worth surfacing.
      if (f.reason === "timeout" || g.reason === "timeout") return fail("timeout");
      return fail(g.reason ?? f.reason ?? "error");
    }
    case "mp4":
    case "hls":
    case "mjpeg":
    case "link":
      // The MJPEG ingester grabs its own thumbnail from a dedicated URL, so it never
      // calls this with mjpeg/link; handled here for completeness (grabFrame covers both).
      return grabFrame(c.live_url);
  }
}

/** Map a raw camera + its classification + captured still into a unified `cams` row (kind='feed'). */
export function buildFeedRow(cam: OsirisCamera, c: Classified, ss: Snapshot | null): FeedRow {
  return {
    id: cam.id,
    kind: "feed",
    source: cam.source ?? null,
    feed_kind: c.feed_kind,
    name: cam.name ?? null,
    city: cam.city ?? null,
    country_name: cam.country ?? null,
    lat: typeof cam.lat === "number" ? cam.lat : null,
    lng: typeof cam.lng === "number" ? cam.lng : null,
    live_url: c.live_url,
    external_url: c.external_url,
    ss_mime: ss?.mime ?? null,
    ss_hash: ss?.hash ?? null,
    ss_base64: ss?.data ?? null,
    raw_json: JSON.stringify(cam),
  };
}
