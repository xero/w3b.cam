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

/**
 * A row to INSERT into the `webcams` table. Keys map 1:1 to the insert columns
 * (an index signature is included so it binds to Bun's named-parameter API).
 */
export type CamRow = {
  ip_str: string;
  port: number;
  shodan_id: string | null;
  transport: string | null;
  timestamp: string | null;
  hostnames: string; // JSON array
  domains: string; // JSON array
  org: string | null;
  isp: string | null;
  asn: string | null;
  os: string | null;
  product: string | null;
  country_name: string | null;
  country_code: string | null;
  city: string | null;
  region_code: string | null;
  latitude: number | null;
  longitude: number | null;
  tags: string; // JSON array
  ss_mime: string;
  ss_hash: number | null;
  ss_base64: string;
  raw_json: string;
} & Record<string, string | number | null>;

/** A row as read back from the DB (adds the generated + app-managed columns). */
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
 * A row to INSERT into the `youtube` table. Keys map 1:1 to the insert columns
 * (an index signature is included so it binds to Bun's named-parameter API).
 * `ss_hash` is a sha256 hex string (TEXT), unlike the numeric Shodan hash.
 */
export type YtRow = {
  video_id: string;
  url: string;
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

/** A youtube row as read back from the DB (adds the generated columns). */
export type StoredYtRow = YtRow & { first_seen: string; last_seen: string };
