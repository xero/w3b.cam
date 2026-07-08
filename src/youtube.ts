// YouTube ingester: fetch each stream's metadata and thumbnail from the YouTube
// Data API and upsert them into the `youtube` table. Idempotent, so re-runs
// refresh existing streams (and pick up updated live thumbnails) rather than
// duplicating them.
//
// Two modes:
//   bun run youtube [--limit N]          read the local list at in/youtube.md
//   bun run youtube --url <url> [--label "Title"]   add/refresh a single stream
//
// The file mode is for local bulk ingest (in/youtube.md is gitignored). The
// single-URL mode takes the stream as an argument, so the CI workflow can add
// one without committing a list.

import { parseArgs } from "node:util";
import { YOUTUBE_MD } from "./config.ts";
import { closeDb, countYtRows, makeYtInserter, openDb } from "./db.ts";
import { mustEnv } from "./util.ts";
import {
  buildYtRow,
  extractVideoId,
  fetchThumbnail,
  fetchVideos,
  parseYoutubeList,
  thumbnailUrls,
} from "./yt-api.ts";
import type { YtRow } from "./types.ts";
import type { YtListEntry } from "./yt-api.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    url: { type: "string", short: "u" },
    label: { type: "string" },
    limit: { type: "string", short: "l" },
  },
  allowPositionals: false,
});

const key = mustEnv("YOUTUBE_API_KEY");

// Build the work list from either a single --url or the youtube.md file.
let entries: YtListEntry[];
let sourceDesc: string;

if (values.url) {
  const videoId = extractVideoId(values.url);
  if (!videoId) {
    console.error(`Could not extract a video id from: ${values.url}`);
    console.error(`Expected a watch?v=, youtu.be/, or /live/ URL.`);
    process.exit(1);
  }
  entries = [{ videoId, label: (values.label ?? "").trim() }];
  sourceDesc = `--url (${videoId})`;
} else {
  const file = Bun.file(YOUTUBE_MD);
  if (!(await file.exists())) {
    console.error(`Missing ${YOUTUBE_MD}. Add one line per stream as "title <url>", or pass --url <url> to add a single one.`);
    process.exit(1);
  }
  entries = parseYoutubeList(await file.text());
  if (entries.length === 0) {
    console.log(`No YouTube URLs found in ${YOUTUBE_MD}.`);
    process.exit(0);
  }
  const limit = values.limit ? Math.max(1, Number.parseInt(values.limit, 10) || 0) : 0;
  if (limit) entries = entries.slice(0, limit);
  sourceDesc = `${YOUTUBE_MD}${limit ? ` (limited to ${limit})` : ""}`;
}

console.log(`Ingesting ${entries.length} stream(s) from ${sourceDesc}.`);

const db = openDb();
const insertMany = makeYtInserter(db);
const startingRows = countYtRows(db);

let added = 0;
let updated = 0;
let changed = 0;
let missing = 0;
let noThumb = 0;

try {
  const items = await fetchVideos(entries.map((e) => e.videoId), key);

  const rows: YtRow[] = [];
  for (const entry of entries) {
    const item = items.get(entry.videoId);
    if (!item) {
      missing++;
      console.warn(`  ${entry.videoId}: not returned by API (deleted/private?), skipping`);
      continue;
    }
    // Try thumbnail sizes best-first; keep the first that actually fetches.
    let ss = null;
    let usedThumbUrl: string | null = null;
    for (const u of thumbnailUrls(item)) {
      ss = await fetchThumbnail(u);
      if (ss) {
        usedThumbUrl = u;
        break;
      }
    }
    if (!ss) {
      noThumb++;
      console.warn(`  ${entry.videoId}: no thumbnail captured`);
    }
    rows.push(buildYtRow(entry.videoId, entry.label, item, usedThumbUrl, ss));
  }

  const r = insertMany(rows);
  added = r.added;
  updated = r.updated;
  changed = r.changed;
} catch (err) {
  console.error(`\nYouTube ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  let endingRows = startingRows;
  try {
    endingRows = countYtRows(db);
  } catch {
    // ignore
  }
  closeDb(db);

  console.log(`\n── Summary ──`);
  console.log(`Streams requested: ${entries.length}`);
  console.log(`New streams added: ${added}`);
  console.log(`Refreshed:         ${updated} existing (${changed} with a changed thumbnail)`);
  if (missing) console.log(`Missing from API:  ${missing}`);
  if (noThumb) console.log(`No thumbnail:      ${noThumb}`);
  console.log(`DB rows:           ${startingRows} → ${endingRows}`);
}
