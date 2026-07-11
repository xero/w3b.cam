// Shared constants for the scraper and visualizer.

/** Default Shodan search query: webcams with a screenshot, excluding desktop captures. */
export const QUERY =
  "has_screenshot:1 screenshot.label:webcam -screenshot.label:desktop";

/** SQLite store path. Override with DB_PATH to run against a throwaway DB (tests/CI) without touching the real one. */
export const DB_PATH = process.env.DB_PATH ?? "camhunting.sqlite";

/** Default directory the importer scans for raw Shodan JSON files. */
export const IN_DIR = "in";

/** Curated list of YouTube live-stream URLs (one `title <url>` per line) `bun import --youtube` ingests, kept in the import dir alongside the raw JSON inputs. */
export const YOUTUBE_MD = `${IN_DIR}/youtube.md`;

/**
 * Consolidated OSINT camera dump (the Osiris dataset) the internal `bun run osiris`
 * command ingests: an envelope `{ generated_at, sources, cameras: [...] }`. Kept
 * under `in/new/`, deliberately outside the top-level `in/*.json` glob that
 * `bun import --shodan` scans; override with a path argument to `bun run osiris <file>`.
 */
export const OSIRIS_JSON = `${IN_DIR}/new/osiris-cameras.json`;

/**
 * Curated MJPEG camera list `bun import --mjpeg` ingests: one bare URL per line (blank
 * lines and `#` comments skipped, an optional `label ` before the URL kept). Kept in
 * the import dir; override with a path argument to `bun import --mjpeg <file>`.
 */
export const MJPEG_MD = `${IN_DIR}/mjpeg.md`;

/** Curated HLS list: one `.m3u8` URL per line (optional label). Override with a path
 *  argument to `bun import --hls <file>`. */
export const STREAMS_MD = `${IN_DIR}/streams.md`;

/** Absolute site origin (no trailing slash). Used to build the absolute links syndication feeds require. */
export const SITE_URL = "https://w3b.cam";

/** Cameras listed in each syndication feed (rss.xml / atom.xml): the newest N by observed_at. */
export const SYNDICATION_LIMIT = 50;

/** Generated static site: root dir, wiped and recreated on every build. */
export const OUT_DIR = "out";
/** Extracted screenshot files, one per unique image, referenced by <img src>. */
export const IMG_DIR = `${OUT_DIR}/img`;
/** Vendored htmx library (installed via bun) and its build-time destination. */
export const HTMX_VENDOR_SRC = "node_modules/htmx.org/dist/htmx.min.js";
export const HTMX_OUT = `${OUT_DIR}/htmx.min.js`;
/** Vendored hls.js (installed via bun), copied to out/ and fetched on demand by the feed client when an HLS cam is viewed. */
export const HLS_VENDOR_SRC = "node_modules/hls.js/dist/hls.min.js";
export const HLS_OUT = `${OUT_DIR}/hls.min.js`;
/** Static assets (favicons, web manifest) copied verbatim into out/ root on build. */
export const ASSETS_DIR = "assets";

/** Host entries shown per index page. */
export const PAGE_SIZE = 8;

/** YouTube streams shown per gallery page (one card per stream, never grouped). */
export const YT_PAGE_SIZE = 8;

/** Feed (Osiris) cams shown per gallery page (one card per cam; the curated set is large). */
export const FEED_PAGE_SIZE = 8;

/** Entities shown per tag-browse page (a blended grid of cams, streams, and feed cards). */
export const TAG_PAGE_SIZE = 8;

/** Shodan returns 100 results per search page. */
export const PER_PAGE = 100;

/** Minimum spacing between API requests (~1 req/sec, with a small margin). */
export const MIN_REQUEST_MS = 1100;

/** Client-level options. Retries are handled by our own backoff wrapper, not the library. */
export const CLIENT_OPTS = { timeout: 15_000 } as const;

/** Max attempts for a single request before giving up (backoff on 429 / 5xx). */
export const MAX_RETRIES = 5;

/** Base delay for exponential backoff. */
export const BACKOFF_BASE_MS = 2_000;
