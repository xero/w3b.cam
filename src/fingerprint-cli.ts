// Fingerprint catch-up backfill (`bun run fingerprint [--apply] [--force]`).
//
// Fingerprinting now runs automatically at ingestion time (db.ts wires the classifiers
// into the cam/feed upserters), so every scrape / import / dev-mode paste writes the
// derived `product` and its `fingerprints` audit row at insert. This CLI is the catch-up
// path: it re-derives the whole `cams` table on demand and rebuilds the `fingerprints`
// audit table from scratch — run it after ADDING a fingerprint rule (ingest only touches
// a row when that row is next (re)ingested, so a new rule reaches the already-stored rows
// only through this backfill). It reuses the same pure decision brain the ingest path does
// (decideCamProduct / fingerprintFeed), so the two can never drift.
//
// Usage:
//   DB_PATH=camhunting.fp.sqlite bun run fingerprint            # dry run: audit + report only
//   DB_PATH=camhunting.fp.sqlite bun run fingerprint --apply    # write cams.product too

import { Database } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import { allRows, allFeedRows, closeDb, openDb } from "./db.ts";
import { canonicalizeExisting, decideCamProduct, fingerprintWebcam, fingerprintFeed, specificity } from "./fingerprint.ts";
import type { Action, FpResult, Tier } from "./fingerprint.ts";
import type { StoredRow } from "./types.ts";

// ── Decision plumbing (audit + apply) ──────────────────────────────────────────────

interface Decision {
	kind: "cam" | "feed";
	ref: string;
	old: string | null;
	next: string;
	tier: Tier | "-";
	method: string;
	vendor: string;
	evidence: string;
	action: Action;
}

/** Decide what to write for one webcam row: reuse the shared brain, then tag it with its ref. */
function decideWebcam(row: StoredRow, fp: FpResult | null): Decision {
	const d = decideCamProduct(row.product, fp);
	return { kind: "cam", ref: `${row.ip_str}:${row.port}`, old: row.product, next: d.product, tier: d.tier, method: d.method, vendor: d.vendor, evidence: d.evidence, action: d.action };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function main(): void {
	const apply = process.argv.includes("--apply");
	const force = process.argv.includes("--force");

	// Guard: never touch the production DB unless explicitly forced.
	if (/(^|\/)camhunting\.sqlite$/.test(DB_PATH) && !force) {
		console.error(`Refusing to run against the production DB (${DB_PATH}).`);
		console.error(`Make a copy and set DB_PATH, e.g.:`);
		console.error(`  cp camhunting.sqlite camhunting.fp.sqlite`);
		console.error(`  DB_PATH=camhunting.fp.sqlite bun run fingerprint${apply ? " --apply" : ""}`);
		console.error(`(or pass --force to override).`);
		process.exit(1);
	}

	console.log(`\n── Fingerprint ${apply ? "APPLY" : "dry run"} · ${DB_PATH} ──`);
	const db = openDb(); // openDb creates the fingerprints table
	try {
		// ── Webcams ──
		const rows = allRows(db);
		const decisions = rows.map((r) => decideWebcam(r, fingerprintWebcam(r.raw_json)));

		// ── Feeds ──
		// A feed keeps its product unless the URL matches a rule (fingerprintFeed truthy),
		// mirroring the ingest path and the feed upsert's product-survives-re-ingest invariant.
		const feed = allFeedRows(db);
		const feedDecisions: Decision[] = [];
		for (const t of feed) {
			const fp = fingerprintFeed(t);
			const old = (t.product ?? null) as string | null;
			if (fp) {
				feedDecisions.push({ kind: "feed", ref: t.id, old, next: fp.product, tier: fp.tier, method: fp.method, vendor: fp.vendor, evidence: fp.evidence, action: (old ?? "").trim() === "" ? "fill" : "upgrade" });
			}
		}

		// ── Write audit (always; rebuilt from scratch each run) ──
		db.run("DELETE FROM fingerprints");
		const ins = db.query(
			`INSERT OR REPLACE INTO fingerprints (kind, ref, tier, method, vendor, evidence)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (const d of [...decisions, ...feedDecisions]) {
				ins.run(d.kind, d.ref, d.tier === "-" ? null : d.tier, d.method, d.vendor === "-" ? null : d.vendor, d.evidence || null);
			}
		})();

		// ── Apply (optional) ──
		// Both sources write the same column on the same table: a Decision's `ref` IS the cams
		// id ('ip:port' for cams, feed id for feeds), so one UPDATE covers both.
		if (apply) {
			const up = db.query("UPDATE cams SET product = ? WHERE id = ?");
			const changedCam = db.transaction(() => {
				let n = 0;
				for (const d of decisions) {
					if (d.action === "fill" || d.action === "fix-server" || d.action === "upgrade" || d.action === "normalize") {
						up.run(d.next, d.ref);
						n++;
					}
				}
				return n;
			})();
			const changedFeeds = db.transaction(() => {
				let n = 0;
				for (const d of feedDecisions) {
					up.run(d.next, d.ref);
					n++;
				}
				return n;
			})();
			console.log(`Applied: ${changedCam} cam product update(s), ${changedFeeds} feed product write(s).`);
		}

		report(db, decisions, feedDecisions, feed.length);
		if (!apply) console.log(`\nDry run. Nothing written to product; review the fingerprints table, then re-run with --apply.`);
	} finally {
		closeDb(db);
	}
}

/** Split an "ip:port" ref, keeping IPv6 colons intact (port is after the last colon). */
function splitRef(ref: string): [string, string] {
	const i = ref.lastIndexOf(":");
	return [ref.slice(0, i), ref.slice(i + 1)];
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function report(db: Database, cam: Decision[], feed: Decision[], feedTotal: number): void {
	// Targets = rows whose stored product was empty or a server name (fill/fix-server actions).
	const targets = cam.filter((d) => d.action === "fill" || d.action === "fix-server");

	console.log(`\n=== WEBCAMS (${cam.length} rows) ===`);
	console.log(`Targets (empty or server-name product): ${targets.length}`);
	console.log(byKey(cam, (d) => d.action, "\nby action:"));
	console.log(byKey(cam.filter((d) => d.tier !== "-"), (d) => d.tier, "\nby tier (rows with a derived label):"));
	console.log(byKey(targets, (d) => d.method, "\ntargets by method:"));
	console.log(topKey(cam.filter((d) => d.next && d.action !== "keep"), (d) => d.next, 30, "\ntop resulting products:"));

	// Single-IP concentration caveat (e.g. the AXIS M3027 decoy on one host).
	const ipCount = new Map<string, number>();
	for (const d of targets) {
		const [ip] = splitRef(d.ref);
		ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1);
	}
	const topIps = [...ipCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
	console.log(`\ntop IPs by fingerprinted ports (watch for single-host inflation):`);
	for (const [ip, n] of topIps) console.log(`  ${String(n).padStart(4)}  ${ip}`);

	console.log(`\n=== FEEDS (${feedTotal} rows) ===`);
	console.log(`  fingerprinted from live_url: ${feed.length}   (left NULL: ${feedTotal - feed.length}, operator networks)`);
	console.log(topKey(feed, (d) => d.next, 15, "\nfeeds products:"));

	// Regression guard: any existing good product that got a strictly less specific label.
	const downgrades = cam.filter((d) => d.action === "upgrade" && specificity(d.next) < specificity(canonicalizeExisting(d.old as string)));
	console.log(`\ndowngrades of existing products: ${downgrades.length} (must be 0)`);
	for (const d of downgrades.slice(0, 10)) console.log(`  ${d.ref}: "${d.old}" -> "${d.next}"`);

	// Rows we could only floor to "Generic IP camera": the candidates for a new rule.
	const floored = cam.filter((d) => d.method === "floor");
	console.log(`\nfloored-to-generic sample (title | server | :port) — candidates for new rules:`);
	for (const d of floored.slice(0, 20)) {
		const row = db.query("SELECT json_extract(raw_json,'$.http.title') t, json_extract(raw_json,'$.http.server') s, port FROM cams WHERE id = ?").get(d.ref) as { t: string | null; s: string | null; port: number } | null;
		if (row) console.log(`  ${(row.t ?? "(no title)").slice(0, 34).padEnd(34)} | ${(row.s ?? "-").slice(0, 22).padEnd(22)} | :${row.port}`);
	}
}

function byKey(rows: Decision[], key: (d: Decision) => string, heading: string): string {
	const c = new Map<string, number>();
	for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
	const lines = [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`);
	return [heading, ...lines].join("\n");
}

function topKey(rows: Decision[], key: (d: Decision) => string, limit: number, heading: string): string {
	const c = new Map<string, number>();
	for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
	const lines = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`);
	return [heading, ...lines].join("\n");
}

if (import.meta.main) main();
