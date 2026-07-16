// ── 511PA camera geolocation feed ────────────────────────────────────────────────
//
// 511PA publishes no coordinates in the URLs we ingest, so an imported 511PA cam lands with
// no lat/lng. Their public map, however, is fed by a DataTables endpoint that returns every PA
// camera with a precise WGS84 point plus roadway/county — keyed by both the numeric Cctv id we
// store as `mjpeg-511pa-<id>` (jpg snapshot cams) and the arcadis channel we store in
// `hls-…/chan-<M>` (HLS video cams). This module fetches that feed once and exposes the two
// indexes, wired into the mjpeg + hls ingest paths so a fresh import lands already geolocated.
// No auth, no cookies; a plain GET with a UA works.
//
//   GET https://www.511pa.com/List/GetData/Cameras?query=<datatables-json>&lang=en-US
//
// The `query` is DataTables boilerplate; the server caps a page at 100 rows, so we page
// through recordsTotal (~1.5k statewide, ~16 requests). Each record carries `images[].id`
// (== Cctv id), `sourceId` (== arcadis chan), and `latLng.geography.wellKnownText`.

import type { OsirisCamera } from "../core/types.ts";

const ENDPOINT = "https://www.511pa.com/List/GetData/Cameras";
const PAGE = 100; // server-enforced max page size
const DEFAULT_DELAY_MS = 400; // polite gap between page requests

/** Geolocation + place metadata for one 511PA camera, keyed elsewhere by its Cctv id. */
export interface Pa511Geo {
  lat: number;
  lng: number;
  county: string | null;
  roadway: string | null;
  direction: string | null;
  location: string | null;
}

// The DataTables `columns`/`order` the site sends. The server needs the column list to
// resolve its sort; the exact shape is copied from the live request.
const QUERY_COLUMNS = [
  { data: null, name: "" },
  { name: "sortOrder", s: true },
  { name: "dotDistrict", s: true },
  { name: "county", s: true },
  { name: "roadway", s: true },
  { name: "turnpikeOnly" },
  { name: "location" },
  { name: "cameraName" },
  { name: "district" },
  { data: 9, name: "" },
];

function pageUrl(start: number, length: number): string {
  const query = { columns: QUERY_COLUMNS, order: [{ column: 1, dir: "asc" }], start, length, search: { value: "" } };
  const p = new URLSearchParams({ query: JSON.stringify(query), lang: "en-US" });
  return `${ENDPOINT}?${p.toString()}`;
}

async function getPage(start: number, length: number): Promise<{ recordsTotal: number; data: unknown[] }> {
  const r = await fetch(pageUrl(start, length), {
    headers: { "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0" },
  });
  if (!r.ok) throw new Error(`511PA geo feed HTTP ${r.status} at start=${start}`);
  return (await r.json()) as { recordsTotal: number; data: unknown[] };
}

// "POINT (lng lat)" -> [lat, lng]; WKT orders X (lng) before Y (lat).
function parseWktPoint(wkt: unknown): [number, number] | null {
  if (typeof wkt !== "string") return null;
  const m = wkt.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
  if (!m) return null;
  const lng = parseFloat(m[1]!);
  const lat = parseFloat(m[2]!);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || t.toLowerCase() === "null" ? null : t;
}

/**
 * The numeric Cctv id embedded in a stored 511PA feed id (`mjpeg-511pa-<n>` -> n), or null
 * if the id isn't a 511PA cam. This is the join key between our rows and the geo feed.
 */
export function pa511CctvId(feedId: string): number | null {
  const m = /^mjpeg-511pa-(\d+)$/.exec(feedId);
  return m ? Number(m[1]) : null;
}

/** The `city`-column value we store for a 511PA cam: its county (the finest locality the
 *  feed carries — `city` itself is always null upstream), phrased "X County". */
export function pa511City(g: Pa511Geo): string | null {
  return g.county ? `${g.county} County` : null;
}

/**
 * The arcadis channel number for a 511PA HLS cam. 511PA's live video cams are stored as `hls-…`
 * rows whose `live_url` is `https://pa-seN.arcadis-ivds.com:8200/chan-<M>/index`; that `<M>` is
 * the join key to the geo feed, where it appears as each record's `sourceId` (verified: sourceId
 * == the videoUrl's chan for every video record, and chan numbers are globally unique across the
 * se1–se4 hosts). Keying on the channel — not the full videoUrl — also matches the handful of
 * records the feed lists without a videoUrl. Null when the url isn't an arcadis 511 HLS stream.
 */
export function pa511ChanId(url: unknown): number | null {
  if (typeof url !== "string") return null;
  const m = url.match(/arcadis-ivds\.com:\d+\/chan-(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Attach a 511PA record's coordinates + county (as `city`) to a synthesized ingest cam. Shared
 *  by the mjpeg and hls paths; the jpg path additionally tidies the name (see tidyPa511Name).
 *  No-op when geo is null, so callers can pass an unmatched lookup straight through. */
export function withPa511Geo(cam: OsirisCamera, geo: Pa511Geo | null): OsirisCamera {
  if (!geo) return cam;
  return { ...cam, country: "USA", city: pa511City(geo), lat: geo.lat, lng: geo.lng };
}

// ── Name tidy ─────────────────────────────────────────────────────────────────────
// 511PA titles arrive SHOUTING with the odd source typo ("COMMERICAL") and no direction.
// tidyPa511Name title-cases them while preserving route/exit/mile-marker tokens, fixes a
// few known typos, and suffixes the travel direction (which the names lack). Idempotent:
// it strips any direction it already added (or the source spelled out) before re-appending,
// so re-running — or a re-import — is a no-op. Shared by the backfill rename + the importer.

const NAME_TYPOS: Record<string, string> = {
  COMMERICAL: "Commercial", WILKINSBURG: "Wilkinsburg", MONTOGOMERY: "Montgomery",
  HIGHWWAY: "Highway", EXTENTION: "Extension",
};
const ROUTE_TOKEN = /^(I|US|PA|SR|WV|OH|MD|NY)-?\d+[A-Z]?$/i; // I-376, PA-576, US 22, SR 2048
const KEEP_UPPER = /^(I|US|PA|SR|WV|OH|MD|NY|NB|SB|EB|WB|MM|MP|HOV|RIDC)$/i;
const EXIT_NUM = /^\d+[A-Z]$/; // 64A, 70C, 28S
const ORDINAL = /^(\d+)(ST|ND|RD|TH)$/i; // 40TH -> 40th
const DIRECTION = /^(east|west|north|south)bound$/i;

function tidyWord(w: string): string {
  if (w === "") return w;
  const up = w.toUpperCase();
  if (NAME_TYPOS[up]) return NAME_TYPOS[up];
  if (ROUTE_TOKEN.test(w) || KEEP_UPPER.test(w) || EXIT_NUM.test(w)) return up;
  if (/^(MM|MP)\d/i.test(w)) return up; // MP1.6, MM53.1 (unspaced mile marker)
  const o = w.match(ORDINAL);
  if (o) return o[1] + o[2]!.toLowerCase();
  if (/^\d+(\.\d+)?$/.test(w)) return w; // bare numbers / mileage
  const cased = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return cased.replace(/^Mc([a-z])/, (_, c: string) => "Mc" + c.toUpperCase()); // McKnight, McKees
}

// Tidy one whitespace-delimited token: split on "/" (so "US 22/US 30" both uppercase) and
// peel leading/trailing punctuation off each piece so "(COMMERCIAL" / "ST)" case correctly.
function tidyToken(tok: string): string {
  return tok
    .split("/")
    .map((seg) => {
      const m = seg.match(/^([^A-Za-z0-9]*)([A-Za-z0-9].*?)?([^A-Za-z0-9]*)$/);
      if (!m || m[2] == null) return seg;
      return m[1] + tidyWord(m[2]) + m[3];
    })
    .join("/");
}

// Drop a direction the name already carries: an appended "Westbound", or a source-spelled
// "- WEST BOUND" / trailing "WB", so re-adding never doubles it.
function stripTrailingDirection(name: string): string {
  return name
    .replace(/[\s,-]*\b(north|south|east|west)\s*bound\b\s*$/i, "")
    .replace(/[\s,-]*\b(NB|SB|EB|WB)\b\s*$/i, "")
    .trim();
}

/** Title-case a 511PA cam name (preserving route tokens), fix known typos, and suffix the
 *  travel direction when it's one of the four cardinals. Idempotent. */
export function tidyPa511Name(name: string, direction?: string | null): string {
  const base = stripTrailingDirection(name).split(/\s+/).map(tidyToken).join(" ").trim();
  const dir = direction && DIRECTION.test(direction)
    ? direction.charAt(0).toUpperCase() + direction.slice(1).toLowerCase()
    : null;
  return dir ? `${base} ${dir}` : base;
}

// The raw paginated feed, memoized per process and shared by both indexes below (the cctv-id
// index for jpg snapshot cams, the video-url index for HLS cams). `force` refetches.
let recordsCache: any[] | null = null;

async function loadPa511Records(opts: { force?: boolean; delayMs?: number } = {}): Promise<any[]> {
  if (recordsCache && !opts.force) return recordsCache;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const first = await getPage(0, PAGE);
  const total = first.recordsTotal;
  const records = [...first.data];
  for (let start = PAGE; start < total; start += PAGE) {
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    records.push(...(await getPage(start, PAGE)).data);
  }
  recordsCache = records as any[];
  return recordsCache;
}

// {lat,lng,county,...} for one feed record, or null when it carries no usable point.
function recordGeo(rec: any): Pa511Geo | null {
  const point = parseWktPoint(rec?.latLng?.geography?.wellKnownText);
  if (!point) return null;
  const [lat, lng] = point;
  return { lat, lng, county: str(rec.county), roadway: str(rec.roadway), direction: str(rec.direction), location: str(rec.location) };
}

/**
 * cctvId -> geo, for the jpg snapshot cams (`mjpeg-511pa-<cctvId>`). One record can list
 * several images; each image.id becomes its own key sharing the record's point.
 */
export async function fetchPa511Geo(opts: { force?: boolean; delayMs?: number } = {}): Promise<Map<number, Pa511Geo>> {
  const map = new Map<number, Pa511Geo>();
  for (const rec of await loadPa511Records(opts)) {
    const geo = recordGeo(rec);
    if (!geo) continue;
    for (const img of Array.isArray(rec.images) ? rec.images : []) {
      const id = Number(img?.id);
      if (Number.isFinite(id)) map.set(id, geo);
    }
  }
  return map;
}

/**
 * chan number -> geo, for the HLS video cams. Keyed by each record's `sourceId` (the arcadis
 * channel), which matches the `chan-<M>` in our stored `live_url` via pa511ChanId.
 */
export async function fetchPa511GeoByChan(opts: { force?: boolean; delayMs?: number } = {}): Promise<Map<number, Pa511Geo>> {
  const map = new Map<number, Pa511Geo>();
  for (const rec of await loadPa511Records(opts)) {
    const geo = recordGeo(rec);
    if (!geo) continue;
    const chan = Number(rec.sourceId);
    if (Number.isFinite(chan)) map.set(chan, geo);
  }
  return map;
}
