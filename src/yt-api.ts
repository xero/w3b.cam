// YouTube Data API v3 client, youtube.md parser, and thumbnail fetch. The API
// key reads public video metadata only (it cannot touch a channel). We request
// just the `snippet` and `liveStreamingDetails` parts; everything else lives in
// raw_json. Native fetch, so no new dependency.
//
// The key is a query param on every request URL, so this file never logs a full
// URL. Error messages carry the status and Google's error body (which does not
// echo the key), never the request URL.

import { createHash } from "node:crypto";
import { BACKOFF_BASE_MS, MAX_RETRIES } from "./config.ts";
import { sleep } from "./util.ts";
import type { YtRow, YtVideoItem, YtVideoListResponse } from "./types.ts";

const API_URL = "https://www.googleapis.com/youtube/v3/videos";
/** videos.list caps `id` at 50 per request. */
const MAX_IDS_PER_CALL = 50;
/** Thumbnail sizes, best first. */
const THUMB_PREFERENCE = ["maxres", "standard", "high", "medium", "default"] as const;

/** A parsed youtube.md entry: the video id and the curated title beside it. */
export interface YtListEntry {
  videoId: string;
  label: string;
}

/** A fetched thumbnail: base64 bytes, mime, and a sha256 hex of the bytes. */
export interface Thumbnail {
  data: string;
  mime: string;
  hash: string;
}

/**
 * Extract the 11-char video id from any of the URL forms in youtube.md:
 * `watch?v=<id>`, `youtu.be/<id>`, `youtube.com/live/<id>`, or `/embed/<id>`.
 * The id charset ([A-Za-z0-9_-]{11}) naturally stops at trailing junk such as
 * the stray full-width space on one line. Returns null if no id is present.
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/live\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** The canonical watch URL for a video id, stored as the row's `url`. */
export const watchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Parse youtube.md into `{ videoId, label }` entries. Each non-empty line is
 * `title <url>`; the label is the text before the URL, stripped of trailing
 * decoration (`►`, `※`, whitespace). Deduped by video id in first-seen order,
 * keeping the longer label when the same id appears twice.
 */
export function parseYoutubeList(text: string): YtListEntry[] {
  const order: string[] = [];
  const labelById = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (!urlMatch || urlMatch.index === undefined) continue;
    const videoId = extractVideoId(urlMatch[0]);
    if (!videoId) continue;
    const label = line
      .slice(0, urlMatch.index)
      .replace(/[►※\s]+$/u, "")
      .trim();
    const existing = labelById.get(videoId);
    if (existing === undefined) {
      order.push(videoId);
      labelById.set(videoId, label);
    } else if (label.length > existing.length) {
      labelById.set(videoId, label);
    }
  }
  return order.map((videoId) => ({ videoId, label: labelById.get(videoId) ?? "" }));
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** fetch() with retry + exponential backoff on 429/5xx and network errors. Never leaks the key-bearing URL. */
async function apiFetch(url: URL, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retriable || attempt >= MAX_RETRIES) {
        const body = await res.text().catch(() => "");
        throw new Error(`YouTube API HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
      }
      const wait = BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      console.warn(`  ${label}: HTTP ${res.status}, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("YouTube API HTTP")) throw err;
      if (attempt >= MAX_RETRIES) throw err;
      const wait = BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      console.warn(`  ${label}: network error, backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

/**
 * Fetch metadata for up to any number of video ids, batching 50 per request.
 * Returns a map of video id to its item. Ids absent from the map were not
 * returned by the API (deleted, private, or otherwise unavailable).
 */
export async function fetchVideos(ids: string[], key: string): Promise<Map<string, YtVideoItem>> {
  const byId = new Map<string, YtVideoItem>();
  const batches = chunk(ids, MAX_IDS_PER_CALL);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const url = new URL(API_URL);
    url.searchParams.set("part", "snippet,liveStreamingDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("maxResults", String(MAX_IDS_PER_CALL));
    url.searchParams.set("key", key);
    const res = await apiFetch(url, `videos batch ${b + 1}/${batches.length}`);
    const json = (await res.json()) as YtVideoListResponse;
    for (const item of json.items ?? []) {
      if (item.id) byId.set(item.id, item);
    }
  }
  return byId;
}

/**
 * Candidate thumbnail URLs for an item, best size first, deduplicated. The caller
 * tries them in order and keeps the first that actually fetches: YouTube sometimes
 * advertises a `maxresdefault` that 404s, so a single best-guess URL isn't enough.
 * Returns [] when the item has no thumbnails.
 */
export function thumbnailUrls(item: YtVideoItem): string[] {
  const thumbs = item.snippet?.thumbnails;
  if (!thumbs) return [];
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (u?: string): void => {
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  for (const size of THUMB_PREFERENCE) add(thumbs[size]?.url);
  // Then any remaining sizes the API returned that aren't in our preference list.
  for (const t of Object.values(thumbs)) add(t?.url);
  return urls;
}

/** Fetch a thumbnail's bytes and return them base64-encoded with a sha256 hex hash, or null on failure. */
export async function fetchThumbnail(url: string): Promise<Thumbnail | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    const hash = createHash("sha256").update(buf).digest("hex");
    return { data: buf.toString("base64"), mime, hash };
  } catch {
    return null;
  }
}

/** Map an API item plus its curated label and fetched thumbnail into a unified `cams` row (kind='stream'). */
export function buildYtRow(
  videoId: string,
  label: string,
  item: YtVideoItem,
  thumbnailUrl: string | null,
  ss: Thumbnail | null,
): YtRow {
  const s = item.snippet ?? {};
  const live = item.liveStreamingDetails ?? {};
  const curated = label || null;
  return {
    id: videoId,
    kind: "stream",
    source: "youtube",
    feed_kind: "youtube",
    name: curated ?? s.title ?? null,
    live_url: watchUrl(videoId),
    label: curated,
    title: s.title ?? null,
    description: s.description ?? null,
    channel_id: s.channelId ?? null,
    channel_title: s.channelTitle ?? null,
    published_at: s.publishedAt ?? null,
    live_content: s.liveBroadcastContent ?? null,
    scheduled_start: live.scheduledStartTime ?? null,
    actual_start: live.actualStartTime ?? null,
    thumbnail_url: thumbnailUrl,
    ss_mime: ss?.mime ?? null,
    ss_hash: ss?.hash ?? null,
    ss_base64: ss?.data ?? null,
    raw_json: JSON.stringify(item),
  };
}
