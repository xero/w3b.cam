import { Database, constants } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import type { CamRow, StoredRow, WebcamMatch } from "./types.ts";
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

export function openDb(path = DB_PATH): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run(SCHEMA);
  migrate(db);
  db.run(BLACKLIST_SCHEMA);
  db.run(HOST_BLACKLIST_SCHEMA);
  db.run(IP_TAGS_SCHEMA);
  seedHostBlacklist(db);
  seedIpTags(db);
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
