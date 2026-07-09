// Unified importer: one command for every non-scraped source. Pick a type with a
// flag; each has its own optional per-type flags plus an optional positional input
// path that overrides the default.
//
//   bun import --shodan [dir]                                       raw Shodan JSON → webcams   (default dir: in/)
//   bun import --youtube [--url <url> [--label "Title"] | file] [--limit N]   YouTube live streams → youtube
//   bun import --mjpeg [file] [--limit N] [--concurrency N]         curated MJPEG URLs → traffic (default: in/mjpeg.md)
//
// Shodan reads no API and spends no credits (screenshots are embedded in the JSON).
// YouTube needs YOUTUBE_API_KEY. The one-off Osiris dump is ingested by the separate
// internal `bun run osiris` command (src/osiris.ts), not this dispatcher.

import { parseArgs } from "node:util";
import { IN_DIR, MJPEG_MD, YOUTUBE_MD } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { ingestMjpegFile, ingestShodanDir, ingestYoutube } from "./ingest.ts";
import { mustEnv } from "./util.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    shodan: { type: "boolean" },
    youtube: { type: "boolean" },
    mjpeg: { type: "boolean" },
    url: { type: "string", short: "u" }, // youtube single-add
    label: { type: "string" }, // youtube single-add title
    limit: { type: "string", short: "l" }, // youtube + mjpeg
    concurrency: { type: "string", short: "c" }, // mjpeg snapshot fan-out
  },
  allowPositionals: true,
});

const USAGE =
  "Usage: bun import --shodan [dir] | --youtube [--url <url> [--label \"Title\"] | file] [--limit N] | --mjpeg [file] [--limit N] [--concurrency N]";

const picked = (["shodan", "youtube", "mjpeg"] as const).filter((t) => values[t]);
if (picked.length !== 1) {
  console.error(picked.length === 0 ? "Pick one import type." : "Pick exactly one import type (they're mutually exclusive).");
  console.error(USAGE);
  process.exit(1);
}
const type = picked[0]!;

/** Parse a positive-int flag, or 0 (meaning "no limit / use the default") when absent/invalid. */
const num = (s?: string): number => (s ? Math.max(1, Number.parseInt(s, 10) || 0) : 0);

// Resolve the YouTube key before opening the DB so a missing key exits cleanly
// (mustEnv → process.exit) without leaking an open handle.
const key = type === "youtube" ? mustEnv("YOUTUBE_API_KEY") : "";

const db = openDb();
try {
  if (type === "shodan") {
    await ingestShodanDir(db, positionals[0] ?? IN_DIR);
  } else if (type === "youtube") {
    if (values.url) await ingestYoutube(db, { url: values.url, label: values.label }, key);
    else await ingestYoutube(db, { file: positionals[0] ?? YOUTUBE_MD, limit: num(values.limit) }, key);
  } else {
    await ingestMjpegFile(db, positionals[0] ?? MJPEG_MD, { limit: num(values.limit), concurrency: num(values.concurrency) });
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closeDb(db);
}
