// Generic HLS source: ingest any curated list of `.m3u8` URLs as live-video feeds.
// Unlike the MJPEG importer (which fingerprints vendor paths), an HLS URL is
// self-describing by its `.m3u8` extension, so classification is trivial and
// vendor-agnostic — 511PA is just one caller, nothing here is tied to it. Each URL
// becomes one `feed` row (feed_kind 'hls'); the detail page embeds it via hls.js.
// The heavy lifting (classify → snapshot → buildFeedRow) is reused from the Osiris
// pipeline, which already turns stream_type 'hls' into an hls feed row.

import type { OsirisCamera } from "./types.ts";

/** One line of a curated HLS list: the URL and any curated label before it. */
export interface HlsEntry {
  url: string;
  label: string;
}

/** A URL whose path ends in the HLS playlist extension (query/hash tolerated). */
const M3U8_EXT = /\.m3u8(?:$|[?#])/i;

/** True when a URL is an http(s) HLS playlist. */
export function isHlsUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return M3U8_EXT.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/**
 * Parse a curated HLS list: one URL per line, blank lines and `#` comments skipped, an
 * optional `label ` before the URL kept (mirrors parseMjpegList). Non-HLS lines are
 * dropped, so a mixed file yields only its `.m3u8` entries. Order preserved; dedup by
 * id is left to the ingester.
 */
export function parseHlsList(text: string): HlsEntry[] {
  const out: HlsEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/https?:\/\/\S+/);
    if (!m || m.index === undefined) continue;
    if (!isHlsUrl(m[0])) continue;
    const label = line.slice(0, m.index).replace(/[►※\s]+$/u, "").trim();
    out.push({ url: m[0], label });
  }
  return out;
}

/**
 * A stable, idempotent id for an HLS stream: host, non-default port, and the playlist
 * path with the `.m3u8` extension dropped. Keeping the path stem (not just its folder)
 * distinguishes siblings under one directory (`/stream/a.m3u8` vs `/stream/b.m3u8`) as
 * well as per-channel folders (`/chan-2333/index` vs `/chan-2334/index`). Already
 * `[a-z0-9_.-]`, so feedSlug is a no-op.
 */
export function hlsId(u: URL): string {
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  const port = u.port && u.port !== defaultPort ? `-${u.port}` : "";
  const path = u.pathname
    .replace(/\.m3u8$/i, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `hls-${u.hostname}${port}${path ? `-${path}` : ""}`.toLowerCase();
}

/**
 * Synthesize an OsirisCamera so the shared osiris classify/snapshot/buildFeedRow path
 * is reused verbatim (stream_type 'hls' → feed_kind 'hls'). `source` tags provenance;
 * the curated label (or the host, as a fallback) becomes the display name.
 */
export function toHlsCam(e: HlsEntry, id: string, source: string): OsirisCamera {
  let host = "";
  try {
    host = new URL(e.url).hostname;
  } catch {}
  return {
    id,
    source,
    country: null,
    city: null,
    name: e.label.trim() || host,
    lat: null,
    lng: null,
    feed_url: null,
    stream_url: e.url,
    stream_type: "hls",
    external_url: null,
  };
}
