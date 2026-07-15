import type { Database } from "bun:sqlite";
import { countYtRows, makeYtInserter } from "../../db/db.ts";
import { buildYtRow, extractVideoId, fetchThumbnail, fetchVideos, parseYoutubeList, thumbnailUrls } from "../yt-api.ts";
import type { YtListEntry } from "../yt-api.ts";
import type { YtRow } from "../../core/types.ts";

// ── YouTube ─────────────────────────────────────────────────────────────────────

interface YtReport {
  added: number;
  updated: number;
  changed: number;
  requested: number;
  missing: number;
  noThumb: number;
}

/** Fetch metadata + thumbnails for a set of entries and upsert them. Silent unless `verbose`. */
export async function ingestYtEntries(db: Database, entries: YtListEntry[], key: string, verbose = false): Promise<YtReport> {
  const items = await fetchVideos(entries.map((e) => e.videoId), key);
  const rows: YtRow[] = [];
  let missing = 0;
  let noThumb = 0;
  for (const entry of entries) {
    const item = items.get(entry.videoId);
    if (!item) {
      missing++;
      if (verbose) console.warn(`  ${entry.videoId}: not returned by API (deleted/private?), skipping`);
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
      if (verbose) console.warn(`  ${entry.videoId}: no thumbnail captured`);
    }
    rows.push(buildYtRow(entry.videoId, entry.label, item, usedThumbUrl, ss));
  }
  const { added, updated, changed } = makeYtInserter(db)(rows);
  return { added, updated, changed, requested: entries.length, missing, noThumb };
}

/**
 * Ingest YouTube streams from either a curated file or a single URL, into the youtube
 * table. Prints progress + summary. Throws (missing file / bad url) for the dispatcher.
 */
export async function ingestYoutube(
  db: Database,
  source: { file: string; limit?: number } | { url: string; label?: string },
  key: string,
): Promise<void> {
  let entries: YtListEntry[];
  let sourceDesc: string;

  if ("url" in source) {
    const videoId = extractVideoId(source.url);
    if (!videoId) throw new Error(`Could not extract a video id from: ${source.url} (expected a watch?v=, youtu.be/, or /live/ URL)`);
    entries = [{ videoId, label: (source.label ?? "").trim() }];
    sourceDesc = `--url (${videoId})`;
  } else {
    const file = Bun.file(source.file);
    if (!(await file.exists())) {
      throw new Error(`Missing ${source.file}. Add one line per stream as "title <url>", or pass --url <url> to add a single one.`);
    }
    entries = parseYoutubeList(await file.text());
    if (entries.length === 0) {
      console.log(`No YouTube URLs found in ${source.file}.`);
      return;
    }
    if (source.limit) entries = entries.slice(0, source.limit);
    sourceDesc = `${source.file}${source.limit ? ` (limited to ${source.limit})` : ""}`;
  }

  console.log(`Ingesting ${entries.length} stream(s) from ${sourceDesc}.`);
  const startingRows = countYtRows(db);
  let rep: YtReport | undefined;
  try {
    rep = await ingestYtEntries(db, entries, key, true);
  } catch (err) {
    console.error(`\nYouTube ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    const endingRows = countYtRows(db);
    console.log(`\n── Summary ──`);
    console.log(`Streams requested: ${entries.length}`);
    console.log(`New streams added: ${rep?.added ?? 0}`);
    console.log(`Refreshed:         ${rep?.updated ?? 0} existing (${rep?.changed ?? 0} with a changed thumbnail)`);
    if (rep?.missing) console.log(`Missing from API:  ${rep.missing}`);
    if (rep?.noThumb) console.log(`No thumbnail:      ${rep.noThumb}`);
    console.log(`DB rows:           ${startingRows} → ${endingRows}`);
  }
}

/** Add/refresh one stream by URL (the dev-mode web importer). Silent; throws on a bad URL. */
export async function ingestYoutubeOne(db: Database, input: { url: string; label?: string }, key: string): Promise<YtReport> {
  const videoId = extractVideoId(input.url);
  if (!videoId) throw new Error("could not extract a video id (expected a watch?v=, youtu.be/, or /live/ URL)");
  return ingestYtEntries(db, [{ videoId, label: (input.label ?? "").trim() }], key);
}

