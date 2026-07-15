// Shared ingest core. One import surface for the CLI dispatcher (ingest/import.ts), the
// internal Osiris CLI (ingest/osiris.ts), and the dev-mode web importer (server/dev.ts).
// Every function takes an open `db` and NEVER opens/closes a DB, parses argv, or exits —
// the executable entrypoints own all of that. Split by source into core/*; this barrel
// re-exports the public ingest functions so callers keep importing from "../ingest/ingest.ts".
//
// Two flavors per source:
//   * bulk `ingest*File`/`Dir` — read a file/dir, print progress + summary, and upsert.
//   * single `ingest*One`/`Text` — silent, return a tally, and THROW on bad input so the
//     web handler can map failures to an HTTP status + error toast.

export { ingestShodanDir, ingestShodanText } from "./core/shodan.ts";
export { ingestYoutube, ingestYoutubeOne } from "./core/youtube.ts";
export { ingestMjpegFile, ingestMjpegOne } from "./core/mjpeg.ts";
export { ingestHlsFile } from "./core/hls.ts";
export { ingestOsirisFile } from "./core/osiris.ts";
