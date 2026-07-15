import type { Database } from "bun:sqlite";
import type { WebcamMatch } from "../../core/types.ts";
import { BLOCKED_PRODUCTS } from "../../core/util.ts";
import type { TagKind } from "./schema.ts";
import { normalizeHost, SS_PERMANENT } from "./common.ts";

/**
 * Purge stored cams whose product we filter at ingestion (RDP/VNC). The ingestion
 * guard (isBlockedProduct) only blocks *new* rows, so this retroactively removes any
 * that predate it. Cam-source only. Returns the number of rows removed.
 */
export function deleteBlockedProducts(db: Database): number {
	const list = [...BLOCKED_PRODUCTS];
	if (list.length === 0) return 0;
	const placeholders = list.map(() => "?").join(", ");
	return db
		.query(`DELETE FROM cams WHERE kind = 'cam' AND lower(trim(product)) IN (${placeholders})`)
		.run(...list).changes;
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

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
 * Delete every stored cam whose hostnames or domains match `host` (itself or a
 * subdomain). SQLite can't suffix-match inside the JSON columns, so we scan cam rows
 * and reuse hostBlocked. Returns the number of cam rows removed and the distinct
 * `ip_str`s they belonged to (a host's ports share one ip_str), so a caller can act on
 * those hosts — e.g. clean their meta. Callers that only want the count use `.rows`.
 */
export function deleteWebcamsByHost(db: Database, host: string): { rows: number; ips: string[] } {
	const hosts = new Set([normalizeHost(host)]);
	const rows = db
		.query("SELECT id, ip_str, hostnames, domains FROM cams WHERE kind = 'cam'")
		.all() as { id: string; ip_str: string | null; hostnames: string | null; domains: string | null }[];
	const del = db.query("DELETE FROM cams WHERE id = ?");
	const delFp = db.query("DELETE FROM fingerprints WHERE kind = 'cam' AND ref = ?");
	return db.transaction(() => {
		let n = 0;
		const ips = new Set<string>();
		for (const r of rows) {
			const names = [...parseHostArray(r.hostnames ?? "[]"), ...parseHostArray(r.domains ?? "[]")];
			if (names.some((name) => hostBlocked(name, hosts))) {
				const c = del.run(r.id).changes;
				delFp.run(r.id); // ref === cams.id for a cam
				n += c;
				if (c && r.ip_str) ips.add(r.ip_str);
			}
		}
		return { rows: n, ips: [...ips] };
	})();
}

/**
 * Delete every stored cam for one IP (all ports) and its fingerprint audit rows. Returns cam
 * rows removed. No meta side effect. The fingerprints ref for a cam is 'ip:port', so an
 * `ip:%` LIKE clears all of the host's ports (the ':' after the IP prevents matching a longer IP).
 */
export function deleteWebcamsByIp(db: Database, ip: string): number {
	db.query("DELETE FROM fingerprints WHERE kind = 'cam' AND ref LIKE ?").run(`${ip}:%`);
	return db.query("DELETE FROM cams WHERE kind = 'cam' AND ip_str = ?").run(ip).changes;
}

/**
 * Delete an entity's tags/featured pins (its meta rows). `ref` is that kind's meta key:
 * ip_str (cam), video_id (stream), id (feed) — see META_SCHEMA.
 */
function deleteEntityMeta(db: Database, kind: TagKind, ref: string): void {
	db.query("DELETE FROM meta WHERE kind = ? AND ref = ?").run(kind, ref);
}

/**
 * Remove one entity and its meta, WITHOUT blacklisting (so it returns on re-ingest). A cam
 * removes every port for the host (matched on ip_str); a stream/feed removes the single row
 * (matched on id). Returns the number of cam/stream/feed rows deleted.
 */
export function removeEntity(db: Database, kind: TagKind, ref: string): number {
	return db.transaction(() => {
		let changes: number;
		if (kind === "cam") {
			changes = deleteWebcamsByIp(db, ref); // also purges the host's fingerprint rows
		} else {
			// feed removes the single row (ref === cams.id); purge its fingerprint audit row too
			// (streams carry none, so the delete is a harmless no-op there).
			changes = db.query("DELETE FROM cams WHERE kind = ? AND id = ?").run(kind, ref).changes;
			db.query("DELETE FROM fingerprints WHERE kind = ? AND ref = ?").run(kind, ref);
		}
		deleteEntityMeta(db, kind, ref);
		return changes;
	})();
}

/**
 * Remove every cam matching `host` (itself or a subdomain) and each removed host's meta,
 * without blacklisting. The hostname counterpart to removeEntity's cam path. Returns the
 * number of cam rows removed.
 */
export function removeWebcamsByHost(db: Database, host: string): number {
	const { rows, ips } = deleteWebcamsByHost(db, host);
	for (const ip of ips) deleteEntityMeta(db, "cam", ip);
	return rows;
}

// ── Preferred screenshot (card image pin) ─────────────────────────────────────

/**
 * Pin (ip_str, port) as the row that represents this host on its gallery card,
 * clearing any prior pin on the same IP so at most one port is ever preferred.
 * Returns false (and changes nothing) if that (ip_str, port) is not stored.
 */
export function setPreferred(db: Database, ip: string, port: number): boolean {
	const id = `${ip}:${port}`;
	if (!db.query("SELECT 1 FROM cams WHERE kind = 'cam' AND id = ?").get(id)) return false;
	db.transaction(() => {
		db.query("UPDATE cams SET preferred = 0 WHERE kind = 'cam' AND ip_str = ?").run(ip);
		db.query("UPDATE cams SET preferred = 1 WHERE id = ?").run(id);
	})();
	return true;
}

/** Clear any pin on this IP (its card reverts to the newest screenshot). Returns true if one existed. */
export function clearPreferred(db: Database, ip: string): boolean {
	return db.query("UPDATE cams SET preferred = 0 WHERE kind = 'cam' AND ip_str = ? AND preferred = 1").run(ip).changes > 0;
}

/**
 * Replace one row's stored thumbnail (the ss_* columns) by primary-key id, stamping
 * last_seen so a later re-scan either MAY overwrite it (`permanent = false` -> datetime('now'),
 * which also clears any prior permanence) or must NOT (`permanent = true` -> the SS_PERMANENT
 * sentinel the upserter honors). Returns false if no row has that id. `hash` is the sha256
 * hex of the decoded image bytes, uniform with the ingest sources. `stamp` is a fixed
 * constant expression, never user input.
 */
export function setThumbnail(db: Database, id: string, mime: string, hash: string, base64: string, permanent: boolean): boolean {
	const stamp = permanent ? `'${SS_PERMANENT}'` : "datetime('now')";
	return db.query(`UPDATE cams SET ss_mime = ?, ss_hash = ?, ss_base64 = ?, last_seen = ${stamp} WHERE id = ?`).run(mime, hash, base64, id).changes > 0;
}
