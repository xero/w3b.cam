// Shared constants for the scraper and visualizer.

/** Default Shodan search query: webcams with a screenshot, excluding desktop captures. */
export const QUERY =
  "has_screenshot:1 screenshot.label:webcam -screenshot.label:desktop";

/** SQLite store path. Override with DB_PATH to run against a throwaway DB (tests/CI) without touching the real one. */
export const DB_PATH = process.env.DB_PATH ?? "camhunting.sqlite";

/** Default directory the importer scans for raw Shodan JSON files. */
export const IN_DIR = "in";

/** Curated list of YouTube live-stream URLs (one `title <url>` per line) the `youtube` command ingests, kept in the import dir alongside the raw JSON inputs. */
export const YOUTUBE_MD = `${IN_DIR}/youtube.md`;

/**
 * Consolidated OSINT camera dump (the Osiris dataset) the `traffic` command
 * ingests: an envelope `{ generated_at, sources, cameras: [...] }`. Kept under the
 * import dir; override with a path argument to `bun run traffic <file>`.
 */
export const OSIRIS_JSON = `${IN_DIR}/new/osiris-cameras.json`;

/** Generated static site: root dir, wiped and recreated on every build. */
export const OUT_DIR = "out";
/** htmx snippets: the inner-<main> fragment of every full page, for hx-get swaps. */
export const SNIPS_DIR = `${OUT_DIR}/snips`;
/** Extracted screenshot files, one per unique image, referenced by <img src>. */
export const IMG_DIR = `${OUT_DIR}/img`;
/** Vendored htmx library (installed via bun) and its build-time destination. */
export const HTMX_VENDOR_SRC = "node_modules/htmx.org/dist/htmx.min.js";
export const HTMX_OUT = `${OUT_DIR}/htmx.min.js`;
/** Vendored hls.js (installed via bun), copied to out/ and fetched on demand by the traffic client when an HLS cam is viewed. */
export const HLS_VENDOR_SRC = "node_modules/hls.js/dist/hls.min.js";
export const HLS_OUT = `${OUT_DIR}/hls.min.js`;
/** Static assets (favicons, web manifest) copied verbatim into out/ root on build. */
export const ASSETS_DIR = "assets";

/** Host entries shown per index page. */
export const PAGE_SIZE = 8;

/** YouTube streams shown per gallery page (one card per stream, never grouped). */
export const YT_PAGE_SIZE = 12;

/** Traffic (Osiris) cams shown per gallery page (one card per cam; the curated set is large). */
export const TRAFFIC_PAGE_SIZE = 24;

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
