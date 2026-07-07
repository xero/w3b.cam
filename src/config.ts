// Shared constants for the scraper and visualizer.

/** Default Shodan search query: webcams with a screenshot, excluding desktop captures. */
export const QUERY =
  "has_screenshot:1 screenshot.label:webcam -screenshot.label:desktop";

export const DB_PATH = "camhunting.sqlite";

/** Default directory the importer scans for raw Shodan JSON files. */
export const IN_DIR = "in";

/** Generated static site: root dir, wiped and recreated on every build. */
export const OUT_DIR = "out";
/** htmx snippets: the inner-<main> fragment of every full page, for hx-get swaps. */
export const SNIPS_DIR = `${OUT_DIR}/snips`;
/** Extracted screenshot files, one per unique image, referenced by <img src>. */
export const IMG_DIR = `${OUT_DIR}/img`;
/** Vendored htmx library (installed via bun) and its build-time destination. */
export const HTMX_VENDOR_SRC = "node_modules/htmx.org/dist/htmx.min.js";
export const HTMX_OUT = `${OUT_DIR}/htmx.min.js`;

/** Host entries shown per index page. */
export const PAGE_SIZE = 8;

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
