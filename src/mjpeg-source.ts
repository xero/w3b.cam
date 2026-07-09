// MJPEG "camhunt" source: classify a hand-curated camera URL (the kind in
// in/new/mjpeg.md) into how we render it in the shared `traffic` table, and derive
// the URL we grab a thumbnail from. Vendor path fingerprints come from tips.md.
//
// The site is served over https, so an embedded http feed is mixed-content-blocked
// and a bad-cert https feed hard-fails as a subresource. Hence the embed rule:
//   * https + a stream endpoint   -> feed_kind "mjpeg" (a live multipart <img>)
//   * https + a snapshot endpoint -> feed_kind "jpg"   (auto-refreshing <img>)
//   * http (anything)             -> feed_kind "link"  (baked still + "View live")
// A server-side ffmpeg/fetch thumbnail is grabbed for every kept cam regardless of
// scheme (grabUrl), so http cams still get a real card image; only the live embed is
// gated. Viewer-page URLs (which return HTML, not media) are turned into a real
// stream/snapshot endpoint via the vendor fingerprint so they still get a thumbnail.

import type { Classified, FeedKind, OsirisCamera } from "./types.ts";

/** Pre-embed category, kept for the ingest summary tally. */
export type MjpegCategory = "mjpeg-stream" | "jpg-snapshot" | "viewer-page";

/** A classified MJPEG cam: a `Classified` (feed_kind/live_url/external_url) plus the
 *  routing metadata the ingester needs. `grabUrl` is the media URL the thumbnail is
 *  pulled from (never an HTML viewer page). */
export interface MjpegClassified extends Classified {
  id: string;
  vendor: string;
  name: string;
  category: MjpegCategory;
  grabUrl: string;
}

/** One line of the curated list: the URL and any curated label before it. */
export interface MjpegEntry {
  url: string;
  label: string;
}

interface Rule {
  re: RegExp;
  vendor: string;
  category: MjpegCategory;
  /** For viewer pages: the stream path to embed/thumbnail (same origin). */
  deriveStream?: string;
  /** For viewer pages: a single-JPEG snapshot path, preferred for thumbnailing. */
  deriveSnapshot?: string;
}

// Ordered: direct-media patterns first (so `/CgiStart/nphMotionJpeg` reads as a
// Panasonic stream, not a CgiStart viewer page), viewer pages last. Grounded in the
// "By vendor" / "Fragments by vendor" tables in tips.md.
const RULES: Rule[] = [
  { re: /\/axis-cgi\/mjpg\/video\.cgi/i, vendor: "Axis", category: "mjpeg-stream" },
  { re: /\/mjpg\/(?:\d+\/)?video\.mjpg/i, vendor: "Generic MJPEG", category: "mjpeg-stream" },
  { re: /nphMotionJpeg/i, vendor: "Panasonic", category: "mjpeg-stream" },
  { re: /\/(?:cgi-bin|control)\/faststream\.jpg/i, vendor: "Mobotix", category: "mjpeg-stream" },
  { re: /\/jpg\/image\.jpg/i, vendor: "Axis", category: "jpg-snapshot" },
  { re: /-wvhttp-01-\/image\.cgi/i, vendor: "Sony/Canon", category: "jpg-snapshot" },
  { re: /\/cgi-bin\/(?:hugesize|fullsize)\.jpg/i, vendor: "Mobotix", category: "jpg-snapshot" },
  {
    re: /\/control\/userimage\.html|\/cgi-bin\/guestimage\.html/i,
    vendor: "Mobotix",
    category: "viewer-page",
    deriveStream: "/cgi-bin/faststream.jpg?stream=full&fps=25",
  },
  {
    re: /\/CgiStart|\/live\/index\.html|\/en\/index\.html|ViewMode=pull/i,
    vendor: "Panasonic",
    category: "viewer-page",
    deriveStream: "/nphMotionJpeg?Resolution=640x480",
    deriveSnapshot: "/SnapshotJPEG?Resolution=640x480",
  },
  {
    re: /#view|\/aca\/index\.html|\/view\/(?:index|view|viewer_index)\.shtml/i,
    vendor: "Axis",
    category: "viewer-page",
    deriveStream: "/axis-cgi/mjpg/video.cgi",
    deriveSnapshot: "/jpg/image.jpg",
  },
];

/** A stable, idempotent id: host, non-default port, and the camera/channel selector
 *  when present (so a multi-cam host yields one row per camera). Survives trafficSlug. */
function mjpegId(u: URL): string {
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== defaultPort ? `-${u.port}` : "";
  const cam = (u.searchParams.get("camera") ?? u.searchParams.get("channel") ?? "").replace(/[^0-9a-z]/gi, "");
  const sel = cam ? `-c${cam}` : "";
  return `mjpeg-${u.hostname}${port}${sel}`.toLowerCase();
}

/**
 * Classify one curated URL, or null if no vendor rule matches (an unrecognized feed
 * we defer rather than store). Direct stream/snapshot URLs are used as-is (they are
 * known-good, curated by hand); viewer-page URLs are turned into a derived media
 * endpoint on the same origin so they still yield a thumbnail and, on https, a live embed.
 */
export function classifyMjpeg(raw: string): MjpegClassified | null {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const path = u.pathname + u.search + u.hash; // hash carries `#view`
  const rule = RULES.find((r) => r.re.test(path));
  if (!rule) return null;

  const origin = `${u.protocol}//${u.host}`;
  let streamUrl: string | null = null;
  let snapshotUrl: string | null = null;
  if (rule.category === "mjpeg-stream") streamUrl = trimmed;
  else if (rule.category === "jpg-snapshot") snapshotUrl = trimmed;
  else {
    streamUrl = rule.deriveStream ? origin + rule.deriveStream : null;
    snapshotUrl = rule.deriveSnapshot ? origin + rule.deriveSnapshot : null;
  }

  // Prefer a single snapshot for the thumbnail (one fetch, no held stream), else the
  // stream (grabFrame's mpjpeg demuxer), else the original as a last resort.
  const grabUrl = snapshotUrl ?? streamUrl ?? trimmed;

  let feed_kind: FeedKind;
  let live_url: string;
  let external_url: string | null;
  const isHttps = u.protocol === "https:";
  if (isHttps && streamUrl) {
    feed_kind = "mjpeg";
    live_url = streamUrl;
    external_url = rule.category === "viewer-page" ? trimmed : null;
  } else if (isHttps && snapshotUrl) {
    feed_kind = "jpg";
    live_url = snapshotUrl;
    external_url = rule.category === "viewer-page" ? trimmed : null;
  } else {
    // http (mixed-content-blocked embed) -> baked still + a "View live" link to the
    // original curated URL (a stream/snapshot plays in a new tab; a viewer page opens).
    feed_kind = "link";
    live_url = trimmed;
    external_url = trimmed;
  }

  return {
    id: mjpegId(u),
    vendor: rule.vendor,
    name: u.host,
    category: rule.category,
    feed_kind,
    live_url,
    external_url,
    grabUrl,
  };
}

/** Rank feed kinds so dedup keeps the richest rendering of a physical cam. */
export function feedRank(kind: FeedKind): number {
  return kind === "mjpeg" ? 3 : kind === "jpg" ? 2 : 1; // link (and anything else) lowest
}

/**
 * Parse the curated list: one URL per line, blank lines and `#` comments skipped, an
 * optional `label ` before the URL kept (mirrors parseYoutubeList). Order preserved;
 * dedup by id is left to the ingester (it needs the classification to pick the best variant).
 */
export function parseMjpegList(text: string): MjpegEntry[] {
  const out: MjpegEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/https?:\/\/\S+/);
    if (!m || m.index === undefined) continue;
    const label = line.slice(0, m.index).replace(/[►※\s]+$/u, "").trim();
    out.push({ url: m[0], label });
  }
  return out;
}

/** Synthesize an OsirisCamera so buildTrafficRow is reused verbatim (and raw_json stays
 *  self-documenting: the original curated URL lives in stream_url/external_url). */
export function toOsirisCam(c: MjpegClassified, label: string): OsirisCamera {
  return {
    id: c.id,
    source: c.vendor,
    country: null,
    city: null,
    name: label.trim() || c.name,
    lat: null,
    lng: null,
    feed_url: c.grabUrl,
    stream_url: c.live_url,
    stream_type: c.feed_kind,
    external_url: c.external_url,
  };
}
