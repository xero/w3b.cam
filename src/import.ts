// Unified importer: one command for every non-scraped source. Pick a type with a
// flag; each has its own optional per-type flags plus an optional positional input
// path that overrides the default.
//
//   bun import --shodan [dir]                                       raw Shodan JSON → webcams   (default dir: in/)
//   bun import --youtube [--url <url> [--label "Title"] | file] [--limit N]   YouTube live streams → youtube
//   bun import --mjpeg [file] [--limit N] [--concurrency N] [--delay MS] [--skip-existing]   curated MJPEG URLs → feed (default: in/mjpeg.md)
//   bun import --hls [file] [--source Name] [--limit N] [--concurrency N] [--delay MS] [--cooldown SEC]   curated .m3u8 URLs → feed (default: in/streams.md)
//     --delay MS       pace grab starts to stay under a per-IP rate limit (cool-off between requests)
//     --cooldown SEC   on a rate-limit streak, sleep SEC and resume instead of aborting
//     --skip-existing  skip streams that already have a thumbnail (per-IP re-runs advance to the gaps)
//     --abort-after N  consecutive timeouts that trip the rate-limit circuit breaker (default 5)
//
// Shodan reads no API and spends no credits (screenshots are embedded in the JSON).
// YouTube needs YOUTUBE_API_KEY. HLS is vendor-agnostic: any .m3u8 list works. The
// one-off Osiris dump is ingested by the separate internal `bun run osiris` command
// (src/osiris.ts), not this dispatcher.

import { parseArgs } from "node:util";
import { IN_DIR, MJPEG_MD, STREAMS_MD, YOUTUBE_MD } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { ingestHlsFile, ingestMjpegFile, ingestShodanDir, ingestYoutube } from "./ingest.ts";
import { mustEnv, num } from "./util.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    shodan: { type: "boolean" },
    youtube: { type: "boolean" },
    mjpeg: { type: "boolean" },
    hls: { type: "boolean" },
    url: { type: "string", short: "u" }, // youtube single-add
    label: { type: "string" }, // youtube single-add title
    source: { type: "string" }, // hls provenance tag
    limit: { type: "string", short: "l" }, // youtube + mjpeg + hls
    concurrency: { type: "string", short: "c" }, // mjpeg + hls snapshot fan-out
    delay: { type: "string" }, // hls: ms paced between grab starts (rate cool-off)
    cooldown: { type: "string" }, // hls: sec to sleep-and-resume on a rate-limit streak
    "skip-existing": { type: "boolean" }, // hls: skip streams that already have a thumbnail
    "abort-after": { type: "string" }, // hls: consecutive timeouts that trip the circuit breaker (default 5)
  },
  allowPositionals: true,
});

const USAGE =
  "Usage: bun import --shodan [dir] | --youtube [--url <url> [--label \"Title\"] | file] [--limit N] | --mjpeg [file] [--limit N] [--concurrency N] [--delay MS] [--skip-existing] | --hls [file] [--source Name] [--limit N] [--concurrency N] [--delay MS] [--cooldown SEC] [--skip-existing] [--abort-after N]";

const picked = (["shodan", "youtube", "mjpeg", "hls"] as const).filter((t) => values[t]);
if (picked.length !== 1) {
  console.error(picked.length === 0 ? "Pick one import type." : "Pick exactly one import type (they're mutually exclusive).");
  console.error(USAGE);
  process.exit(1);
}
const type = picked[0]!;

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
  } else if (type === "hls") {
    await ingestHlsFile(db, positionals[0] ?? STREAMS_MD, {
      source: values.source,
      limit: num(values.limit),
      concurrency: num(values.concurrency),
      delayMs: num(values.delay),
      cooldownSec: num(values.cooldown),
      skipExisting: values["skip-existing"],
      abortAfter: num(values["abort-after"]),
    });
  } else {
    await ingestMjpegFile(db, positionals[0] ?? MJPEG_MD, {
      limit: num(values.limit),
      concurrency: num(values.concurrency),
      delayMs: num(values.delay),
      skipExisting: values["skip-existing"],
    });
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closeDb(db);
}
