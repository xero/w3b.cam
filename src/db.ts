import { Database, constants } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import type { CamRow, StoredRow, StoredTrafficRow, StoredYtRow, TrafficRow, WebcamMatch, YtRow } from "./types.ts";
import { BLOCKED_PRODUCTS } from "./util.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS webcams (
  ip_str        TEXT    NOT NULL,
  port          INTEGER NOT NULL,
  shodan_id     TEXT,
  transport     TEXT,
  timestamp     TEXT,
  hostnames     TEXT    NOT NULL,   -- JSON array
  domains       TEXT    NOT NULL,   -- JSON array
  org           TEXT,
  isp           TEXT,
  asn           TEXT,
  os            TEXT,
  product       TEXT,
  country_name  TEXT,
  country_code  TEXT,
  city          TEXT,
  region_code   TEXT,
  latitude      REAL,
  longitude     REAL,
  tags          TEXT    NOT NULL,   -- JSON array
  ss_mime       TEXT    NOT NULL,
  ss_hash       INTEGER,
  ss_base64     TEXT    NOT NULL,   -- base64 payload, no "data:" prefix
  raw_json      TEXT    NOT NULL,   -- full match minus image bytes
  first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
  preferred     INTEGER NOT NULL DEFAULT 0,   -- 1 = pinned as this host's card image (set via reorder); never written by import
  PRIMARY KEY (ip_str, port)
) STRICT;
`;

/**
 * Insert columns, in order. Excludes the generated `first_seen`, the
 * explicitly-set `last_seen`, and `preferred`: leaving `preferred` out of both the
 * INSERT and the ON CONFLICT UPDATE is exactly what lets a pin (see setPreferred)
 * survive re-imports of the same (ip_str, port).
 */
const COLUMNS = [
  "ip_str", "port", "shodan_id", "transport", "timestamp", "hostnames",
  "domains", "org", "isp", "asn", "os", "product", "country_name",
  "country_code", "city", "region_code", "latitude", "longitude", "tags",
  "ss_mime", "ss_hash", "ss_base64", "raw_json",
] as const;

/**
 * YouTube live streams, a second source kept apart from the Shodan `webcams`
 * table because the metadata is different (video/channel, live status, dates).
 * One row per video, keyed on `video_id`. Screenshot columns are nullable: a
 * thumbnail fetch can fail and the stream should still be catalogued. `ss_hash`
 * is a sha256 hex string, unlike the numeric Shodan hash, so a re-run that pulls
 * an updated live thumbnail registers as a changed screenshot. `channel_id` is
 * the grouping key used only to link sibling streams on a detail page; the
 * gallery lists every row.
 */
const YOUTUBE_SCHEMA = `
CREATE TABLE IF NOT EXISTS youtube (
  video_id        TEXT    NOT NULL PRIMARY KEY,
  url             TEXT    NOT NULL,
  label           TEXT,             -- curated title from youtube.md
  title           TEXT,             -- snippet.title
  description     TEXT,             -- snippet.description
  channel_id      TEXT,             -- grouping key (sibling streams)
  channel_title   TEXT,
  published_at    TEXT,             -- snippet.publishedAt
  live_content    TEXT,             -- snippet.liveBroadcastContent: live|upcoming|none
  scheduled_start TEXT,             -- liveStreamingDetails.scheduledStartTime
  actual_start    TEXT,             -- liveStreamingDetails.actualStartTime
  thumbnail_url   TEXT,             -- the snippet.thumbnails url we fetched
  ss_mime         TEXT,             -- nullable: a fetch can fail
  ss_hash         TEXT,             -- sha256 hex of the fetched bytes, for change detection
  ss_base64       TEXT,             -- nullable
  raw_json        TEXT    NOT NULL, -- full API item
  first_seen      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen       TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * YouTube insert columns, in order. Excludes the generated `first_seen` (kept on
 * conflict) and `last_seen` (set explicitly to datetime('now')), mirroring how
 * COLUMNS treats the webcams table.
 */
const YT_COLUMNS = [
  "video_id", "url", "label", "title", "description", "channel_id",
  "channel_title", "published_at", "live_content", "scheduled_start",
  "actual_start", "thumbnail_url", "ss_mime", "ss_hash", "ss_base64", "raw_json",
] as const;

/**
 * Manual coordinates for YouTube streams, kept apart from the `youtube` table
 * because unlike the other two sources YouTube publishes no location: these are
 * our own best-guess lat/lng, hand-assigned from the place named in a stream's
 * title (city centroid, or the landmark itself). One row per video, keyed on
 * `video_id`; a stream absent from this table simply gets no map dot. Seeded once
 * on a fresh table (see seedYtGeo) and editable with `bun run geo`, mirroring how
 * ip_tags / featured are seeded-then-curated.
 */
const YT_GEO_SCHEMA = `
CREATE TABLE IF NOT EXISTS yt_geo (
  video_id  TEXT NOT NULL PRIMARY KEY,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * video_id -> [lat, lng] seed for yt_geo on a fresh database, best-guess from each
 * stream's title. Applied only when the table is empty (see seedYtGeo), so a coord
 * removed or corrected by hand never reverts. Streams whose title names no single
 * place (the FalconCam feeds, the roaming "Multi-Cam" feeds, the "Railcam UK
 * Sampler") are intentionally absent and stay off the map.
 */
const YT_GEO_SEED: Readonly<Record<string, readonly [number, number]>> = {
  // Koh Samui, Thailand (Lamai / Chaweng / Bophut beaches)
  e9T0L_POAOk: [9.533, 100.062], // "The Best Pancake Man" (Chaweng)
  Tpj0cmMVOd0: [9.47, 100.052], // Baobab, Lamai Beach
  w47yvCftkWQ: [9.47, 100.05], // Bondi Aussie Bar (Lamai)
  "VR-x3HdhKLQ": [9.47, 100.05], // Bondi Aussie Bar
  NTTtqzL5OWI: [9.462, 100.055], // Crystal Bay Beach Resort (Lamai)
  Fw9hgttWzIg: [9.462, 100.055], // Crystal Bay Beach Resort
  "3N3ZwIB_X4Y": [9.46, 100.056], // Crystal Bay Yacht Club (Lamai)
  LGNYKz4yziE: [9.46, 100.056], // Crystal Bay Yacht Club - Panoramic
  kkVrj2cr9Ko: [9.46, 100.056], // Crystal Bay Yacht Club Lamai
  CSp55hSd_6A: [9.573, 100.061], // Fisherman's Village (Bophut)
  FyFAqPHBKiQ: [9.573, 100.061], // Fisherman's Village (Bophut)
  x73IEW0fOo0: [9.573, 100.065], // Floating Lotus Big Buddha
  "6MMXJrzT5c0": [9.533, 100.062], // Henry Africa's Bar (Chaweng)
  DwKCna1mumk: [9.545, 100.061], // Hush Bar (Soi Green Mango)
  UNbOvsRAx9U: [9.545, 100.061], // Punch Machine (Soi Green Mango)
  yFgVmioYkys: [9.545, 100.061], // Soi Green Mango (Chaweng)
  bbBGNNPu0rg: [9.573, 100.061], // The Shack, Fisherman's Village
  OBJ5Q0lWbqk: [9.533, 100.062], // Tropical Murphy's Irish Pub
  RiSXbSQmTyw: [9.468, 100.053], // Villa Tao, Lamai
  // Bangkok, Thailand
  a_bUVExv_Cg: [13.751, 100.54], // Petchaburi Road
  UemFRPrl1hk: [13.738, 100.56], // Sukhumvit Road
  Q71sLS8h9a4: [13.738, 100.56], // Sukhumvit Road
  // Duluth / North Shore, Minnesota, USA
  _L0u39B732I: [46.722, -92.104], // AMI Connors Point
  EbVlhVeD3jA: [46.78, -92.098], // Bayfront
  m2wWzo9GmwY: [46.78, -92.09], // Beach
  "36MiI7NltHk": [46.779, -92.093], // Aerial Lift Bridge
  E0YlMI4P8Fw: [46.75, -92.11], // Cargo Connect
  "05WivhRmKq4": [46.77, -92.1], // Harbor
  bBubIPZYVt0: [46.77, -92.1], // Harbor Plaza / GLA
  DzJb26edNjs: [46.79, -92.1], // Hillside
  c1kfkIoF0k0: [46.766, -92.108], // Pier B
  zTVWJ3Mc0Ag: [47.288, -91.257], // Silver Bay Marina
  ZXlXNf_w5Lw: [46.779, -92.089], // South Pier Lighthouse
  "9EnmgL3fXW8": [47.2, -91.367], // Split Rock Lighthouse
  rCec9HDbFwA: [47.023, -91.671], // Two Harbors Depot
  mpMdJJjw59E: [46.75, -92.12], // Western Harbor
  sThx7mQM3Uc: [46.708, -91.995], // Wisconsin Point
  HPS48TMmNag: [46.779, -92.091], // canal
  nCf7X2cPDAY: [46.779, -92.089], // lighthouse
  Yw8CZCEOdXE: [45.885, -95.377], // Big Ole Cam, Alexandria MN
  zKDNVIGoOSQ: [40.758, -73.985], // Manhattan rooftop, NYC
  // Calgary, Alberta, Canada
  xsRDTfuksyI: [51.038, -114.07], // Central Memorial Park
  MwcqP3ta6RI: [51.048, -114.066], // Downtown
  // Japan (Kyoto / Saga-Arashiyama / Tokyo / Nagasaki)
  ldO0Eqoomms: [35.028, 135.678], // Daikakuji Temple
  hy7sPwngWNQ: [33.852, 132.786], // Dogo Onsen, Matsuyama
  Onyb8uHQV5Y: [34.967, 135.773], // Fushimi-Inari Taisha
  J3xHBUgWRqc: [35.003, 135.775], // Hanamikoji Street, Gion
  KHglGodzQ9g: [35.031, 135.735], // Kitano-Tenmangu Shrine
  v9rQqa_VTEY: [34.986, 135.758], // Kyoto Station Bus Terminal
  CO_ZjH6N7RE: [34.985, 135.759], // Kyoto Station Hachijo Taxi
  zNahac5x0Tw: [32.916, 129.914], // Nagasaki Airport
  "niQh-vFZBs4": [35.0, 135.78], // Nene no michi, Higashiyama
  VqTF7RQfRTc: [35.66, 139.72], // Nishiazabu, Tokyo
  qZ2ghbe3zc0: [35.005, 135.765], // Nishiki Market
  S6IkZhhwG4A: [35.027, 135.794], // Philosopher's Path
  "Qm4X_oY-9YM": [35.021, 135.667], // Saga-Toriimoto
  "Op-lf2NRMzs": [35.017, 135.671], // Arashiyama Bamboo Forest
  jqtsC5BYlIk: [35.013, 135.678], // Togetsukyo bridge
  "4Za-6AXfu4w": [35.024, 135.673], // Seiryoji Temple
  "1Xm5bjdI5hU": [35.671, 139.764], // Sukiyabashi crossing, Ginza
  // European cities
  "4DjwrvoTKwk": [41.378, 2.192], // Barcelona - Beach
  IRqboacDNFg: [52.521, 13.413], // Berlin - Alexanderplatz
  xFdvZ4eGzPg: [48.14, 17.117], // Bratislava - Danube
  LSPN10FbR3U: [40.42, -3.705], // Madrid - Gran Via
  "4CaHlfpGlAI": [40.417, -3.703], // Madrid - Puerta del Sol
  dsoM6TYIkOI: [45.464, 9.19], // Milan - Duomo
  KxWuwC7R5kY: [48.137, 11.575], // Munich - Marienplatz
  LO2Fvujwc8M: [40.852, 14.268], // Naples
  asO_10T0k2k: [43.7, 7.265], // Nice - City View
  YAdNYoRY0Cw: [43.694, 7.259], // Nice - Promenade des Anglais
  UMuEooW0iAQ: [48.858, 2.294], // Paris - Eiffel Tower
  OzYp4NRZlwQ: [48.861, 2.336], // Paris - Louvre
  tmlE1ct0cYk: [50.086, 14.411], // Prague - Charles Bridge
  sspBOJIrNzU: [50.088, 14.42], // Prague - City View
  "89d3tEaqImM": [41.89, 12.492], // Rome - Colosseum
  "mt7uE-n0YPI": [45.44, 12.328], // Venice - Grand Canal
  // Middle East
  qJf4NqPKLjI: [33.893, 35.501], // Beirut Skyline
  "77akujLn4k8": [31.777, 35.234], // Jerusalem Western Wall
  u_4FJ4M7gGE: [31.5, 34.9], // Barn Owl (Israel), country-level
  // United Kingdom
  "1FsH5EeOppg": [52.06, -1.334], // Banbury Station
  BnIq_jumCl8: [54.148, -2.297], // Horton-in-Ribblesdale
  pwKtRjDAXik: [54.148, -2.297], // Horton-in-Ribblesdale Quarry
  oiLG19R9PmE: [54.968, -1.617], // Newcastle Central Station
  t65TCpcJOPQ: [53.089, -2.433], // Crewe
  R1P9v9bEtuk: [50.735, -1.163], // Ryde Pier, Isle of Wight
  ug3AO8rn0IE: [50.545, -3.5], // Teign Estuary, Teignmouth
  vByZX49lCic: [53.958, -1.093], // York
  ZC7HiaMkmlU: [53.09, -2.4357], // Railcam UK Sampler (anchored at Crewe, Railcam's hub)
  // Austria (Semmering / Wechsel ski area)
  "T-NTOEpqx9I": [47.605, 16.004], // Kirchberg am Wechsel
  ypcVXc9EEb8: [47.598, 15.96], // Kirchberg - Steyersberger Schwaig
  _klXKK3kyMY: [47.636, 15.828], // Semmering - Panoramahotel Wagner
  Npz21TdGN7w: [47.633, 15.833], // Semmering - Passhoehe
  "5stfSF-G6kI": [47.635, 15.826], // Semmering - Sporthotel
  "1Wyfd_ytFQk": [47.552, 15.947], // Wexlarena Corona Coaster
  "eJs-IowPqxM": [47.552, 15.947], // Wexlarena St. Corona
  vS9fLLaMNLI: [47.552, 15.947], // Wexlarena St. Corona
  // Australia
  sCPKGMfHGQA: [-27.443, 153.038], // Bowen Hills, Brisbane
  xW1YcHVp7Ko: [-34.726, 135.87], // Port Lincoln OspreyCam
  // FalconCam Project, Charles Sturt University Orange Campus, NSW, Australia
  yv2RtoIMNzA: [-33.3068, 149.1012], // Box Camera FalconCam
  VuZaWzhXSAI: [-33.3068, 149.1012], // Ledge Camera FalconCam
  rQxrTGgNu4M: [-33.3068, 149.1012], // Tower cam FalconCam
  // Monterey Bay Aquarium, California, USA (tank cams, one venue)
  cUoet3dmRU4: [36.618, -121.902], // Aviary
  m1XcdxjVGos: [36.618, -121.902], // Jelly
  w3LjpFhySTg: [36.618, -121.902], // Kelp Forest
  "fVa6-zCBR7A": [36.618, -121.902], // Monterey Bay
  "7N9-FODmuBA": [36.618, -121.902], // Moon Jelly
  n_GpVsz4nHU: [36.618, -121.902], // Open Sea
  "abbR-Ttd-cA": [36.618, -121.902], // Sea Otter
  dzmJXWmA2EM: [36.618, -121.902], // Spider Crab
  tEtg5Kg3voQ: [36.618, -121.902], // Shark
  // Brazil
  "0qhqrRm2biY": [-23.007, -47.134], // VCP - Viracopos Airport, Campinas
};

/**
 * Traffic (Osiris) cams, a third source kept apart from the other two tables
 * because these are LIVE pointers, not stored feeds. `feed_kind` records how the
 * detail page renders the cam (jpg/mp4/hls/link) and `live_url` is the URL it
 * embeds or links. The `ss_*` columns still hold a baked card thumbnail so the
 * gallery and image pipeline work exactly like the other sources; they are
 * nullable because a snapshot (JPEG fetch or ffmpeg frame) can fail and `link`
 * cams have none. `ss_hash` is a sha256 hex string, like the youtube table, so a
 * re-run that captures a fresher frame registers as a changed screenshot. One row
 * per cam, keyed on the namespaced `id` (unique in the dump).
 */
const TRAFFIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS traffic (
  id            TEXT    NOT NULL PRIMARY KEY,
  source        TEXT,
  name          TEXT,
  city          TEXT,
  country       TEXT,
  lat           REAL,
  lng           REAL,
  feed_kind     TEXT    NOT NULL,   -- 'jpg' | 'mp4' | 'hls' | 'link'
  live_url      TEXT    NOT NULL,   -- URL the detail page embeds (jpg/mp4/hls) or links (link)
  external_url  TEXT,               -- optional human-facing viewer page
  ss_mime       TEXT,               -- nullable: a snapshot can fail
  ss_hash       TEXT,               -- sha256 hex of the baked thumbnail bytes
  ss_base64     TEXT,               -- nullable
  raw_json      TEXT    NOT NULL,   -- the original camera object
  first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * Traffic insert columns, in order. Excludes the generated `first_seen` (kept on
 * conflict) and `last_seen` (set explicitly to datetime('now')), mirroring how
 * COLUMNS and YT_COLUMNS treat their tables.
 */
const TRAFFIC_COLUMNS = [
  "id", "source", "name", "city", "country", "lat", "lng",
  "feed_kind", "live_url", "external_url",
  "ss_mime", "ss_hash", "ss_base64", "raw_json",
] as const;

/** IPs we've removed and never want to ingest again. Keyed on IP only (every port). */
const BLACKLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS blacklist (
  ip_str    TEXT NOT NULL PRIMARY KEY,
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * Hostnames/domains we never want to ingest, keyed on a registrable host stored
 * lowercase with no trailing dot. A listed host matches itself and any subdomain
 * (see hostBlocked), so `cloudzy.com` blocks `cam.node.cloudzy.com` too.
 */
const HOST_BLACKLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS host_blacklist (
  host      TEXT NOT NULL PRIMARY KEY,
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`;

/**
 * Hostnames/domains used to seed the host blacklist on a fresh database. Applied
 * only when the table is empty (see seedHostBlacklist), so hand-removed entries
 * never come back. Only hostnames are seeded; add IPs with `bun run blacklist <ip>`.
 */
const HOST_BLACKLIST_SEED: readonly string[] = [
  "cloudzy.com",
  "had.pm",
  "northstate.net",
];

/**
 * Free-form tags attached to an IP (host), independent of any camera or port: a
 * single IP may carry several. Keyed on (ip_str, tag) so a tag can't be applied to
 * the same IP twice. On a host page these are concatenated with commas, mirroring
 * how ports are shown. `tag` is stored normalized (see normalizeTag).
 */
const IP_TAGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ip_tags (
  ip_str    TEXT NOT NULL,
  tag       TEXT NOT NULL,
  added_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ip_str, tag)
) STRICT;
`;

/**
 * Tag -> IPs used to seed ip_tags on a fresh database. Applied only when the table
 * is empty (see seedIpTags), so a tag removed by hand never comes back. Tags are
 * normalized on insert, so casing/whitespace here is cosmetic.
 */
const IP_TAGS_SEED: Readonly<Record<string, readonly string[]>> = {
  graffiti: [
    "149.232.133.220",
    "149.232.137.67",
    "46.250.173.71",
    "46.250.171.73",
    "46.250.173.83",
    "181.2.201.255",
    "46.250.171.180",
    "149.232.135.7",
    "46.250.169.102",
  ],
  games: [
    "24.136.120.51",
    "24.136.120.52",
    "202.39.216.179",
    "87.138.95.183",
  ],
  backrooms: [
    "5.26.172.20",
    "220.134.169.248",
    "82.166.212.224",
    "84.120.199.77",
  ],
};

/**
 * The cams and streams pinned to the homepage (index.html). Two slots per kind;
 * the homepage renders each slot's featured card alongside the two newest of that
 * kind. `ref` is an `ip_str` when kind='cam' and a `video_id` when kind='stream',
 * so this one table pins both sources (unlike ip_tags, which is IP-only). Keyed on
 * (kind, slot) so a slot holds exactly one ref and `setFeatured` upserts in place.
 */
const FEATURED_SCHEMA = `
CREATE TABLE IF NOT EXISTS featured (
  kind      TEXT    NOT NULL,   -- 'cam' | 'stream'
  slot      INTEGER NOT NULL,   -- 1-based position within its kind
  ref       TEXT    NOT NULL,   -- ip_str for cams, video_id for streams
  added_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, slot)
) STRICT;
`;

/** Which source a featured slot points at: an IP (cam) or a YouTube video id (stream). */
export type FeaturedKind = "cam" | "stream";

/**
 * Homepage seed applied to `featured` on a fresh database. Like the other seeds it
 * runs only when the table is empty (see seedFeatured), so a slot re-pointed by hand
 * (or via `bun run feature`) never reverts.
 */
const FEATURED_SEED: readonly { kind: FeaturedKind; slot: number; ref: string }[] = [
  { kind: "cam", slot: 1, ref: "149.232.130.7" },
  { kind: "cam", slot: 2, ref: "160.72.56.179" },
  { kind: "stream", slot: 1, ref: "Yw8CZCEOdXE" },
  { kind: "stream", slot: 2, ref: "UNbOvsRAx9U" },
];

export function openDb(path = DB_PATH): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(SCHEMA);
  migrate(db);
  db.run(YOUTUBE_SCHEMA);
  db.run(YT_GEO_SCHEMA);
  db.run(TRAFFIC_SCHEMA);
  db.run(BLACKLIST_SCHEMA);
  db.run(HOST_BLACKLIST_SCHEMA);
  db.run(IP_TAGS_SCHEMA);
  db.run(FEATURED_SCHEMA);
  seedHostBlacklist(db);
  seedIpTags(db);
  seedFeatured(db);
  seedYtGeo(db);
  return db;
}

/**
 * Bring an existing database up to the current schema. SQLite forbids a
 * non-constant default (datetime('now')) in ALTER TABLE ADD COLUMN, so we add
 * last_seen nullable and backfill from first_seen. Every future write supplies
 * last_seen explicitly (see makeInserter), so the missing default is harmless.
 */
function migrate(db: Database): void {
  const cols = db.query("PRAGMA table_info(webcams)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "last_seen")) {
    db.run("ALTER TABLE webcams ADD COLUMN last_seen TEXT");
    db.run("UPDATE webcams SET last_seen = first_seen WHERE last_seen IS NULL");
  }
  // A constant default is allowed in ALTER (unlike datetime('now')), and ADD COLUMN
  // never rewrites existing rows, so this is instant; old rows read back as 0.
  if (!cols.some((c) => c.name === "preferred")) {
    db.run("ALTER TABLE webcams ADD COLUMN preferred INTEGER NOT NULL DEFAULT 0");
  }
}

/** Checkpoint the WAL back into the main file (macOS keeps -wal/-shm otherwise) and close. */
export function closeDb(db: Database): void {
  try {
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    db.run("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {}
  db.close();
}

/** Tally of what a bulk insert did: brand-new rows, refreshed rows, and how many refreshes carried a new screenshot. */
export interface InsertResult {
  /** Rows whose (ip_str, port) was not previously stored. */
  added: number;
  /** Rows that already existed and were overwritten with newer data. */
  updated: number;
  /** Subset of `updated` whose screenshot hash changed (genuinely new image). */
  changed: number;
}

/**
 * Build a transactional bulk upserter. Inserts new (ip_str, port) rows and
 * refreshes existing ones (screenshot + metadata + last_seen), preserving the
 * original first_seen. Returns a tally of added / updated / changed rows.
 */
export function makeInserter(db: Database): (rows: CamRow[]) => InsertResult {
  const placeholders = COLUMNS.map((c) => `$${c}`).join(", ");
  const updates = COLUMNS
    .filter((c) => c !== "ip_str" && c !== "port")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const stmt = db.query(
    `INSERT INTO webcams (${COLUMNS.join(", ")}, last_seen)
     VALUES (${placeholders}, datetime('now'))
     ON CONFLICT(ip_str, port) DO UPDATE SET ${updates}, last_seen = excluded.last_seen`,
  );
  // ON CONFLICT DO UPDATE reports changes>0 for both inserts and updates, so we
  // can't infer "new" from changes. Peek at the prior screenshot hash instead.
  const prior = db.query("SELECT ss_hash AS h FROM webcams WHERE ip_str = ? AND port = ?");
  return db.transaction((rows: CamRow[]): InsertResult => {
    let added = 0;
    let updated = 0;
    let changed = 0;
    for (const row of rows) {
      const before = prior.get(row.ip_str, row.port) as { h: number | null } | null;
      stmt.run(row);
      if (before == null) {
        added++;
      } else {
        updated++;
        if (before.h !== row.ss_hash) changed++;
      }
    }
    return { added, updated, changed };
  });
}

export function countRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM webcams").get() as { c: number };
  return row.c;
}

export function allRows(db: Database): StoredRow[] {
  return db
    .query("SELECT * FROM webcams ORDER BY country_name, ip_str, port")
    .all() as StoredRow[];
}

// ── YouTube ───────────────────────────────────────────────────────────────────

/**
 * Build a transactional bulk upserter for the `youtube` table. Inserts new
 * `video_id` rows and refreshes existing ones (metadata + thumbnail + last_seen),
 * preserving the original first_seen. Returns a tally of added / updated /
 * changed rows. Mirrors makeInserter; `changed` counts refreshes whose thumbnail
 * hash differed (a genuinely new frame).
 */
export function makeYtInserter(db: Database): (rows: YtRow[]) => InsertResult {
  const placeholders = YT_COLUMNS.map((c) => `$${c}`).join(", ");
  const updates = YT_COLUMNS
    .filter((c) => c !== "video_id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const stmt = db.query(
    `INSERT INTO youtube (${YT_COLUMNS.join(", ")}, last_seen)
     VALUES (${placeholders}, datetime('now'))
     ON CONFLICT(video_id) DO UPDATE SET ${updates}, last_seen = excluded.last_seen`,
  );
  // ON CONFLICT DO UPDATE reports changes>0 for both inserts and updates, so peek
  // at the prior screenshot hash to tell a new row from a refreshed one.
  const prior = db.query("SELECT ss_hash AS h FROM youtube WHERE video_id = ?");
  return db.transaction((rows: YtRow[]): InsertResult => {
    let added = 0;
    let updated = 0;
    let changed = 0;
    for (const row of rows) {
      const before = prior.get(row.video_id) as { h: string | null } | null;
      stmt.run(row);
      if (before == null) {
        added++;
      } else {
        updated++;
        if (before.h !== row.ss_hash) changed++;
      }
    }
    return { added, updated, changed };
  });
}

export function countYtRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM youtube").get() as { c: number };
  return row.c;
}

/**
 * Every YouTube row, ordered so live streams sort first and streams sharing a
 * channel stay adjacent (then newest-first within a channel). The renderer does
 * the channel grouping for detail-page siblings; the gallery never collapses
 * rows, so this order is exactly the card order.
 */
export function allYtRows(db: Database): StoredYtRow[] {
  return db
    .query(
      `SELECT * FROM youtube
       ORDER BY
         CASE live_content WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
         channel_title,
         published_at DESC,
         video_id`,
    )
    .all() as StoredYtRow[];
}

// ── YouTube geo (manual coordinates) ────────────────────────────────────────

/**
 * Populate yt_geo from YT_GEO_SEED, but only on a fresh (empty) table. Idempotent:
 * once the table holds any row this is a no-op, so it never re-adds a coord removed
 * by hand. Mirrors seedIpTags / seedFeatured.
 */
export function seedYtGeo(db: Database): void {
  const { c } = db.query("SELECT COUNT(*) AS c FROM yt_geo").get() as { c: number };
  if (c > 0) return;
  const stmt = db.query("INSERT OR IGNORE INTO yt_geo (video_id, lat, lng) VALUES (?, ?, ?)");
  db.transaction((seed: Readonly<Record<string, readonly [number, number]>>) => {
    for (const [id, [lat, lng]] of Object.entries(seed)) stmt.run(id, lat, lng);
  })(YT_GEO_SEED);
}

/**
 * Every stream's manual coordinates as a map of video_id -> {lat, lng}, loaded once
 * for a build. Videos with no assigned coord are absent (the build gives them no map
 * dot). Companion to loadIpTags.
 */
export function loadYtGeo(db: Database): Map<string, { lat: number; lng: number }> {
  const rows = db.query("SELECT video_id, lat, lng FROM yt_geo").all() as { video_id: string; lat: number; lng: number }[];
  const map = new Map<string, { lat: number; lng: number }>();
  for (const r of rows) map.set(r.video_id, { lat: r.lat, lng: r.lng });
  return map;
}

/** Set (or replace) a stream's coordinates. Upsert, so re-running `bun run geo` on the same id never dupes a row. */
export function setYtGeo(db: Database, videoId: string, lat: number, lng: number): void {
  db.query(
    `INSERT INTO yt_geo (video_id, lat, lng) VALUES (?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, added_at = datetime('now')`,
  ).run(videoId, lat, lng);
}

// ── Traffic (Osiris) ────────────────────────────────────────────────────────

/**
 * Build a transactional bulk upserter for the `traffic` table. Inserts new `id`
 * rows and refreshes existing ones (metadata + thumbnail + last_seen), preserving
 * the original first_seen. Returns a tally of added / updated / changed rows.
 * Mirrors makeYtInserter; `changed` counts refreshes whose thumbnail hash differed
 * (a genuinely fresher frame).
 */
export function makeTrafficInserter(db: Database): (rows: TrafficRow[]) => InsertResult {
  const placeholders = TRAFFIC_COLUMNS.map((c) => `$${c}`).join(", ");
  const updates = TRAFFIC_COLUMNS
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const stmt = db.query(
    `INSERT INTO traffic (${TRAFFIC_COLUMNS.join(", ")}, last_seen)
     VALUES (${placeholders}, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET ${updates}, last_seen = excluded.last_seen`,
  );
  // ON CONFLICT DO UPDATE reports changes>0 for both inserts and updates, so peek
  // at the prior screenshot hash to tell a new row from a refreshed one.
  const prior = db.query("SELECT ss_hash AS h FROM traffic WHERE id = ?");
  return db.transaction((rows: TrafficRow[]): InsertResult => {
    let added = 0;
    let updated = 0;
    let changed = 0;
    for (const row of rows) {
      const before = prior.get(row.id) as { h: string | null } | null;
      stmt.run(row);
      if (before == null) {
        added++;
      } else {
        updated++;
        if (before.h !== row.ss_hash) changed++;
      }
    }
    return { added, updated, changed };
  });
}

export function countTrafficRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS c FROM traffic").get() as { c: number };
  return row.c;
}

/**
 * Every traffic row. Cams with a baked thumbnail sort first so the gallery leads
 * with working previews (a dead/blocked feed that captured no still sinks to the
 * back rather than dominating page 1); within each group, ordered by country then
 * source then name for a stable, browsable order. The gallery never groups rows
 * (one card per cam), so this order is exactly the card order.
 */
export function allTrafficRows(db: Database): StoredTrafficRow[] {
  return db
    .query("SELECT * FROM traffic ORDER BY (ss_base64 IS NULL), country, source, name, id")
    .all() as StoredTrafficRow[];
}

/** True when any stored camera has this exact IP (any port). */
export function hasHost(db: Database, ip: string): boolean {
  return db.query("SELECT 1 FROM webcams WHERE ip_str = ? LIMIT 1").get(ip) != null;
}

/**
 * Purge stored cameras whose product we filter at ingestion (RDP/VNC). The
 * ingestion guard (isBlockedProduct) only blocks *new* rows, so this retroactively
 * removes any that predate it. Returns the number of rows removed.
 */
export function deleteBlockedProducts(db: Database): number {
  const list = [...BLOCKED_PRODUCTS];
  if (list.length === 0) return 0;
  const placeholders = list.map(() => "?").join(", ");
  return db
    .query(`DELETE FROM webcams WHERE lower(trim(product)) IN (${placeholders})`)
    .run(...list).changes;
}

// ── Blacklist ───────────────────────────────────────────────────────────────

/**
 * Populate host_blacklist with HOST_BLACKLIST_SEED, but only on a fresh (empty)
 * table. Idempotent: once the table holds any row this is a no-op, so it never
 * brings back an entry that was later removed by hand.
 */
export function seedHostBlacklist(db: Database): void {
  const { c } = db.query("SELECT COUNT(*) AS c FROM host_blacklist").get() as { c: number };
  if (c > 0) return;
  const stmt = db.query("INSERT OR IGNORE INTO host_blacklist (host) VALUES (?)");
  db.transaction((hosts: readonly string[]) => {
    for (const h of hosts) stmt.run(normalizeHost(h));
  })(HOST_BLACKLIST_SEED);
}

/** Canonical host key: trimmed, lowercased, trailing FQDN dot removed. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Canonical tag key: trimmed and lowercased, so casing/whitespace never dupes a tag. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * Populate ip_tags from IP_TAGS_SEED, but only on a fresh (empty) table. Idempotent:
 * once the table holds any row this is a no-op, so it never re-adds a tag removed by
 * hand. Mirrors seedHostBlacklist.
 */
export function seedIpTags(db: Database): void {
  const { c } = db.query("SELECT COUNT(*) AS c FROM ip_tags").get() as { c: number };
  if (c > 0) return;
  const stmt = db.query("INSERT OR IGNORE INTO ip_tags (ip_str, tag) VALUES (?, ?)");
  db.transaction((seed: Readonly<Record<string, readonly string[]>>) => {
    for (const [tag, ips] of Object.entries(seed)) {
      const t = normalizeTag(tag);
      for (const ip of ips) stmt.run(ip.trim(), t);
    }
  })(IP_TAGS_SEED);
}

/**
 * Every IP's tags as a map of ip_str -> tag list, loaded once for a build. IPs with
 * no tags are absent (callers default a miss to []). Tags come back sorted so the
 * comma-joined display on a host page is stable.
 */
export function loadIpTags(db: Database): Map<string, string[]> {
  const rows = db
    .query("SELECT ip_str, tag FROM ip_tags ORDER BY ip_str, tag")
    .all() as { ip_str: string; tag: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.ip_str);
    if (list) list.push(r.tag);
    else map.set(r.ip_str, [r.tag]);
  }
  return map;
}

/**
 * Add a single tag to an IP, normalized (see normalizeTag). Mirrors the tag CLI's
 * `INSERT OR IGNORE INTO ip_tags`. Returns true if newly added, false if the IP
 * already carried that tag (or the tag normalizes to empty).
 */
export function addIpTag(db: Database, ip: string, tag: string): boolean {
  const t = normalizeTag(tag);
  if (t === "") return false;
  return db.query("INSERT OR IGNORE INTO ip_tags (ip_str, tag) VALUES (?, ?)").run(ip, t).changes > 0;
}

/** Every distinct tag name across all IPs, sorted. Feeds the dev-mode tag autocomplete. */
export function distinctTags(db: Database): string[] {
  return (db.query("SELECT DISTINCT tag FROM ip_tags ORDER BY tag").all() as { tag: string }[])
    .map((r) => r.tag);
}

/**
 * Every distinct tag with how many IPs carry it, ordered by tag name. Since
 * ip_tags is keyed on (ip_str, tag), a tag can't repeat on one IP, so COUNT(*)
 * per tag is exactly its host count. Counts every tagged IP in the table, whether
 * or not that host has stored cameras, so the tag cloud reflects the raw tagging
 * effort. Feeds the tags-cloud page (see renderTagsMain).
 */
export function loadTagCounts(db: Database): { tag: string; count: number }[] {
  return db
    .query("SELECT tag, COUNT(*) AS count FROM ip_tags GROUP BY tag ORDER BY tag")
    .all() as { tag: string; count: number }[];
}

// ── Featured (homepage pins) ──────────────────────────────────────────────────

/**
 * Seed the `featured` table from FEATURED_SEED, but only on a fresh (empty) table.
 * Idempotent: once any slot is set this is a no-op, so a slot re-pointed by hand
 * never reverts. Mirrors seedIpTags / seedHostBlacklist.
 */
export function seedFeatured(db: Database): void {
  const { c } = db.query("SELECT COUNT(*) AS c FROM featured").get() as { c: number };
  if (c > 0) return;
  const stmt = db.query("INSERT OR IGNORE INTO featured (kind, slot, ref) VALUES (?, ?, ?)");
  db.transaction((seed: readonly { kind: FeaturedKind; slot: number; ref: string }[]) => {
    for (const s of seed) stmt.run(s.kind, s.slot, s.ref);
  })(FEATURED_SEED);
}

/**
 * The homepage's featured refs, split by kind and ordered by slot: `cams` holds
 * ip_strs, `streams` holds video_ids. The build resolves each ref against the
 * current rows (a ref whose row is gone is simply skipped, see build.ts).
 */
export function loadFeatured(db: Database): { cams: string[]; streams: string[] } {
  const rows = db
    .query("SELECT kind, slot, ref FROM featured ORDER BY kind, slot")
    .all() as { kind: string; slot: number; ref: string }[];
  const cams: string[] = [];
  const streams: string[] = [];
  for (const r of rows) {
    if (r.kind === "cam") cams.push(r.ref);
    else if (r.kind === "stream") streams.push(r.ref);
  }
  return { cams, streams };
}

/** Pin `ref` into (kind, slot), replacing whatever that slot held. Upsert, so re-featuring a slot never dupes a row. */
export function setFeatured(db: Database, kind: FeaturedKind, slot: number, ref: string): void {
  db.query(
    `INSERT INTO featured (kind, slot, ref) VALUES (?, ?, ?)
     ON CONFLICT(kind, slot) DO UPDATE SET ref = excluded.ref, added_at = datetime('now')`,
  ).run(kind, slot, ref);
}

/** True when a stream with this exact video_id is stored. Companion to hasHost. */
export function hasStream(db: Database, videoId: string): boolean {
  return db.query("SELECT 1 FROM youtube WHERE video_id = ? LIMIT 1").get(videoId) != null;
}

/** True when `name` equals, or is a subdomain of, any listed host. Case/dot-insensitive. */
function hostBlocked(name: string, hosts: Set<string>): boolean {
  const n = normalizeHost(name);
  if (!n) return false;
  for (const bad of hosts) {
    if (n === bad || n.endsWith(`.${bad}`)) return true;
  }
  return false;
}

/** Parse a stored JSON string array, tolerating malformed values (returns []). */
function parseHostArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Blacklist state loaded once per run, with an O(1)-ish membership check for ingestion. */
export interface Blacklist {
  ips: Set<string>;
  hosts: Set<string>;
  /** True when a match should be skipped: its IP, or any hostname/domain, is listed. */
  blocks(m: WebcamMatch): boolean;
}

/** Load both blacklists (IPs and hostnames) into an object that can vet a match. */
export function loadBlacklist(db: Database): Blacklist {
  const ipRows = db.query("SELECT ip_str FROM blacklist").all() as { ip_str: string }[];
  const hostRows = db.query("SELECT host FROM host_blacklist").all() as { host: string }[];
  const ips = new Set(ipRows.map((r) => r.ip_str));
  const hosts = new Set(hostRows.map((r) => r.host));
  return {
    ips,
    hosts,
    blocks(m: WebcamMatch): boolean {
      if (m.ip_str && ips.has(m.ip_str)) return true;
      if (hosts.size === 0) return false;
      for (const h of m.hostnames ?? []) if (hostBlocked(h, hosts)) return true;
      for (const d of m.domains ?? []) if (hostBlocked(d, hosts)) return true;
      return false;
    },
  };
}

/** Add an IP to the blacklist. Returns true if newly added, false if already present. */
export function blacklist(db: Database, ip: string): boolean {
  return db.query("INSERT OR IGNORE INTO blacklist (ip_str) VALUES (?)").run(ip).changes > 0;
}

/** Remove an IP from the blacklist. Returns true if it was listed, false if not present. */
export function unblacklist(db: Database, ip: string): boolean {
  return db.query("DELETE FROM blacklist WHERE ip_str = ?").run(ip).changes > 0;
}

/** Add a hostname to the blacklist. Returns true if newly added, false if already present. */
export function blacklistHost(db: Database, host: string): boolean {
  return db.query("INSERT OR IGNORE INTO host_blacklist (host) VALUES (?)")
    .run(normalizeHost(host)).changes > 0;
}

/** Remove a hostname from the blacklist. Returns true if it was listed, false if not present. */
export function unblacklistHost(db: Database, host: string): boolean {
  return db.query("DELETE FROM host_blacklist WHERE host = ?").run(normalizeHost(host)).changes > 0;
}

/**
 * Delete every stored camera whose hostnames or domains match `host` (itself or a
 * subdomain). SQLite can't suffix-match inside the JSON columns, so we scan rows
 * and reuse hostBlocked. Returns the number of rows removed.
 */
export function deleteWebcamsByHost(db: Database, host: string): number {
  const hosts = new Set([normalizeHost(host)]);
  const rows = db
    .query("SELECT ip_str, port, hostnames, domains FROM webcams")
    .all() as { ip_str: string; port: number; hostnames: string; domains: string }[];
  const del = db.query("DELETE FROM webcams WHERE ip_str = ? AND port = ?");
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      const names = [...parseHostArray(r.hostnames), ...parseHostArray(r.domains)];
      if (names.some((name) => hostBlocked(name, hosts))) {
        n += del.run(r.ip_str, r.port).changes;
      }
    }
    return n;
  })();
}

// ── Preferred screenshot (card image pin) ─────────────────────────────────────

/**
 * Pin (ip_str, port) as the row that represents this host on its gallery card,
 * clearing any prior pin on the same IP so at most one port is ever preferred.
 * Returns false (and changes nothing) if that (ip_str, port) is not stored.
 */
export function setPreferred(db: Database, ip: string, port: number): boolean {
  if (!db.query("SELECT 1 FROM webcams WHERE ip_str = ? AND port = ?").get(ip, port)) return false;
  db.transaction(() => {
    db.query("UPDATE webcams SET preferred = 0 WHERE ip_str = ?").run(ip);
    db.query("UPDATE webcams SET preferred = 1 WHERE ip_str = ? AND port = ?").run(ip, port);
  })();
  return true;
}

/** Clear any pin on this IP (its card reverts to the newest screenshot). Returns true if one existed. */
export function clearPreferred(db: Database, ip: string): boolean {
  return db.query("UPDATE webcams SET preferred = 0 WHERE ip_str = ? AND preferred = 1").run(ip).changes > 0;
}
