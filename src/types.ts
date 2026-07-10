// Our own view of the Shodan data. `shodan-ts`'s ShodanService has a
// `[key: string]: unknown` catch-all and does NOT model `screenshot`, so we
// define the fields we actually consume and cast at the boundary (see util.ts).

/** The screenshot sub-object attached to a banner. `mime` (not `mimetype`) is the format. */
export interface ShodanScreenshot {
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
  /** MIME type, e.g. "image/jpeg". */
  mime: string;
  /** Numeric hash of the image (signed 32-bit, may be negative). */
  hash: number;
  /** ML-generated labels, e.g. ["webcam", "login"]. */
  labels?: string[];
  /** OCR text extracted from the image. */
  text?: string;
}

/** Location fields we read off a match (all optional/nullable, so code defensively). */
export interface MatchLocation {
  city?: string | null;
  region_code?: string | null;
  country_code?: string | null;
  country_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  area_code?: number | null;
}

/** The subset of a search match we care about. Nearly everything is optional. */
export interface WebcamMatch {
  ip_str?: string;
  port?: number;
  transport?: string | null;
  timestamp?: string | null;
  hostnames?: string[];
  domains?: string[];
  org?: string | null;
  isp?: string | null;
  asn?: string | null;
  os?: string | null;
  product?: string | null;
  tags?: string[];
  location?: MatchLocation;
  /** Untyped in shodan-ts; we extract via getScreenshot(). */
  screenshot?: unknown;
  /** Untyped in shodan-ts; carries the per-banner UUID under `.id`. */
  _shodan?: unknown;
}

// ── Unified `cams` table ──────────────────────────────────────────────────────
// All three sources live in one `cams` table now, discriminated by `kind`
// ('cam' = Shodan device, 'feed' = live-pointer feed [ex-"traffic"], 'stream' =
// YouTube). `id` is the universal key: 'ip:port' for a cam, the slug for a feed,
// the video_id for a stream. Each source's builder fills its own column subset
// (see CAM_COLUMNS / FEED_COLUMNS / STREAM_COLUMNS in db.ts); columns it doesn't
// own read back NULL. `ss_hash` is a sha256 hex string across all three now.

/**
 * A cam-source (Shodan) row to INSERT into `cams`. Keys map 1:1 to CAM_COLUMNS
 * (an index signature is included so it binds to Bun's named-parameter API).
 */
export type CamRow = {
  id: string; // `${ip_str}:${port}`
  kind: string; // 'cam'
  source: string | null; // 'shodan'
  feed_kind: string; // 'screenshot'
  name: string | null; // first hostname/domain -> product -> ip (see util.ts)
  product: string | null;
  ip_str: string;
  port: number;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country_code: string | null;
  country_name: string | null;
  region_code: string | null;
  ss_mime: string | null;
  ss_hash: string | null; // sha256 hex of the screenshot bytes
  ss_base64: string | null;
  shodan_id: string | null;
  hostnames: string; // JSON array
  domains: string; // JSON array
  org: string | null;
  isp: string | null;
  asn: string | null;
  observed_at: string | null; // Shodan observation time (was `timestamp`)
  raw_json: string;
} & Record<string, string | number | null>;

/** A `cams` row (kind='cam') as read back, with the generated + app-managed columns. */
export type StoredRow = CamRow & { first_seen: string; last_seen: string; preferred: number };

// ── YouTube ──────────────────────────────────────────────────────────────────
// A second stream source: YouTube live cams, kept in their own `youtube` table.
// We read only the `snippet` and `liveStreamingDetails` parts of a videos.list
// item; everything else stays in raw_json. All fields are optional since the API
// omits them freely (e.g. liveStreamingDetails is absent on a non-live video).

/** One entry of the `snippet.thumbnails` map. */
export interface YtThumbnail {
  url: string;
  width?: number;
  height?: number;
}

/** The `snippet` part of a videos.list item (subset we consume). */
export interface YtSnippet {
  publishedAt?: string;
  channelId?: string;
  title?: string;
  description?: string;
  channelTitle?: string;
  /** "live" | "upcoming" | "none". */
  liveBroadcastContent?: string;
  /** Keyed by size: default | medium | high | standard | maxres. */
  thumbnails?: Record<string, YtThumbnail | undefined>;
}

/** The `liveStreamingDetails` part of a videos.list item (subset we consume). */
export interface YtLiveStreamingDetails {
  actualStartTime?: string;
  scheduledStartTime?: string;
}

/** A single item from a videos.list response. */
export interface YtVideoItem {
  id?: string;
  snippet?: YtSnippet;
  liveStreamingDetails?: YtLiveStreamingDetails;
}

/** A videos.list response envelope (the fields we read). */
export interface YtVideoListResponse {
  items?: YtVideoItem[];
}

/**
 * A stream-source (YouTube) row to INSERT into `cams`. Keys map 1:1 to
 * STREAM_COLUMNS. `id` is the video id; `live_url` is the canonical watch URL.
 * `lat`/`lng` are NOT written here (hand-assigned via `bun run geo`, so they
 * survive re-ingest), hence absent from this insert shape.
 */
export type YtRow = {
  id: string; // video_id
  kind: string; // 'stream'
  source: string | null; // 'youtube'
  feed_kind: string; // 'youtube'
  name: string | null; // curated label, else API title
  live_url: string; // canonical watch URL
  label: string | null; // curated title from youtube.md
  title: string | null; // snippet.title
  description: string | null;
  channel_id: string | null;
  channel_title: string | null;
  published_at: string | null;
  live_content: string | null;
  scheduled_start: string | null;
  actual_start: string | null;
  thumbnail_url: string | null;
  ss_mime: string | null;
  ss_hash: string | null;
  ss_base64: string | null;
  raw_json: string;
} & Record<string, string | number | null>;

/** A `cams` row (kind='stream') as read back (adds the generated columns). */
export type StoredYtRow = YtRow & { first_seen: string; last_seen: string; lat: number | null; lng: number | null };

// ── Traffic (Osiris) ───────────────────────────────────────────────────────────
// A third source: public/OSINT cameras consolidated from the Osiris project, kept
// in their own `traffic` table. Unlike the other two sources these are LIVE
// pointers (auto-updating JPEG snapshots, MP4/HLS streams, third-party embeds)
// rather than stored image bytes. Hybrid rendering: a still is snapshotted at
// ingest for the gallery card (ss_* columns, exactly like the other sources), and
// the live feed itself is embedded only on the detail page via `live_url`/`feed_kind`.

/**
 * How a traffic cam is rendered, derived once at ingest. `jpg` auto-refreshes an
 * <img>; `mjpeg` streams a multipart <img> live; `mp4`/`hls` embed a <video>; `link`
 * shows a baked still plus a "View live" link-out only (no embed). The Osiris
 * ingester (classify in traffic-source.ts) emits only jpg/mp4/hls; the MJPEG
 * ingester (mjpeg-source.ts) emits mjpeg/jpg/link. `link` covers http-only cams
 * (mixed-content-blocked on our https site) and viewer pages we cannot embed.
 */
export type FeedKind = "jpg" | "mp4" | "hls" | "mjpeg" | "link";

/** One camera object from the Osiris JSON dump (`cameras[]`). Everything but `id` is optional/nullable at the edge. */
export interface OsirisCamera {
  id: string;
  source?: string | null;
  country?: string | null;
  city?: string | null;
  name?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Direct snapshot URL (usually a JPEG); may instead be a viewer page or auth-gated endpoint. */
  feed_url?: string | null;
  /** Live video/stream URL, paired with `stream_type`. */
  stream_url?: string | null;
  /** "hls" | "mp4" | "iframe" | "jpg". */
  stream_type?: string | null;
  /** Human-facing viewer page (link-out target). */
  external_url?: string | null;
}

/**
 * A feed-source (ex-"traffic": live JPEG/MJPEG/MP4/HLS/link pointers) row to
 * INSERT into `cams`. Keys map 1:1 to FEED_COLUMNS. `product` is NOT written here
 * (it's the fingerprint-backfill target, so it survives re-ingest), hence absent
 * from this insert shape. `live_url` is the URL the detail page embeds or links.
 */
export type TrafficRow = {
  id: string;
  kind: string; // 'feed'
  source: string | null;
  feed_kind: FeedKind;
  name: string | null;
  city: string | null;
  country_name: string | null; // the feed's country (was `country`)
  lat: number | null;
  lng: number | null;
  live_url: string; // embed URL (jpg/mjpeg/mp4/hls) or primary link (link kind)
  external_url: string | null; // optional human-facing page (view-live link)
  ss_mime: string | null;
  ss_hash: string | null; // sha256 hex of the fetched bytes, for change detection
  ss_base64: string | null;
  raw_json: string;
} & Record<string, string | number | null>;

/** A `cams` row (kind='feed') as read back. Adds the generated columns plus
 * `product` (the fingerprint-backfill target, read but never written by ingest). */
export type StoredTrafficRow = TrafficRow & { first_seen: string; last_seen: string; product: string | null };

/**
 * One make's slice of the camera device breakdown shown on the tags page. Built by
 * fingerprint.ts `productBreakdown` from the `product` fingerprints and rendered as a
 * make → model → count table (see render.ts `renderProductBreakdown`).
 */
export interface ProductGroup {
  make: string;
  /** Total cameras across this make's models. */
  total: number;
  /** Models under this make, count-descending. `model` is "—" when only the make is known. */
  models: { model: string; count: number }[];
}

/** The output of classifying a raw Osiris cam (see traffic-source.ts): how to render it, and the URLs involved. */
export interface Classified {
  feed_kind: FeedKind;
  /** URL the detail page embeds (jpg/mp4/hls) or links (link kind). */
  live_url: string;
  /** Optional human-facing viewer page (the "view live" link target). */
  external_url: string | null;
}
