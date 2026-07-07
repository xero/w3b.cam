// Visualizer: read the SQLite DB and write a paginated multi-file static site.
// Screenshots are extracted to files under out/img/ (deduped by content hash) and
// referenced by <img src>. Every page is emitted twice: the full HTML document and
// a snippet (the inner-<main> content) that htmx swaps in for SPA-like navigation.
// The two are derived from the same string, so they can never drift.
//
// Usage:  bun run bake   (then: bun run serve)

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
	HTMX_OUT,
	HTMX_VENDOR_SRC,
	IMG_DIR,
	OUT_DIR,
	PAGE_SIZE,
	SNIPS_DIR,
} from "./config.ts";
import { allRows, closeDb, openDb } from "./db.ts";
import { isBlockedProduct } from "./util.ts";
import {
	extFromMime,
	groupByIp,
	pageFileName,
	renderHostMain,
	renderIndexMain,
	renderShell,
	snippetFileName,
	TITLE,
	type Host,
} from "./render.ts";
import type { StoredRow } from "./types.ts";

/** Decode a row's screenshot to a file (deduped by content hash) and return its URL. */
async function extractImages(rows: StoredRow[]): Promise<Map<string, string>> {
	const byKey = new Map<string, string>();
	const written = new Set<string>();
	for (const r of rows) {
		// Same base64 cleanup the single-page build did: strip Shodan's 76-col wrapping.
		const clean = r.ss_base64.replace(/[^A-Za-z0-9+/=]/g, "");
		const buf = Buffer.from(clean, "base64");
		const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		const name = `${hash}.${extFromMime(r.ss_mime)}`;
		if (!written.has(name)) {
			await Bun.write(`${IMG_DIR}/${name}`, buf);
			written.add(name);
		}
		byKey.set(`${r.ip_str}:${r.port}`, `/img/${name}`);
	}
	return byKey;
}

async function writePage(fullName: string, snipName: string, mainInner: string, title: string, headerText: string): Promise<void> {
	await Bun.write(`${OUT_DIR}/${fullName}`, renderShell({ title, headerText, mainInner }));
	await Bun.write(`${SNIPS_DIR}/${snipName}`, `${mainInner}\n`);
}

// ── Load ──────────────────────────────────────────────────────────────────────

const db = openDb();
let rows: StoredRow[];
try {
	// Blocked products (RDP/VNC) are filtered at ingestion, but rows that predate
	// that guard can still be in the DB. Never render them, whatever the DB holds.
	rows = allRows(db).filter((r) => !isBlockedProduct(r.product));
} finally {
	closeDb(db);
}

// ── Wipe and recreate out/ from scratch ─────────────────────────────────────────

await rm(OUT_DIR, { recursive: true, force: true });

if (!(await Bun.file(HTMX_VENDOR_SRC).exists())) {
	console.error(`Missing ${HTMX_VENDOR_SRC}. Run \`bun install\` first.`);
	process.exit(1);
}
await Bun.write(HTMX_OUT, Bun.file(HTMX_VENDOR_SRC));

// ── Build the grouped model ──────────────────────────────────────────────────

const imgByKey = await extractImages(rows);
const imgHref = (row: StoredRow): string => imgByKey.get(`${row.ip_str}:${row.port}`) ?? "";
const hosts: Host[] = groupByIp(rows, imgHref);

const headerText = `${hosts.length.toLocaleString()} ${hosts.length === 1 ? "host" : "hosts"} · ${rows.length.toLocaleString()} ${rows.length === 1 ? "camera" : "cameras"}`;

// ── Paginated index (page 1 is index.html; empty DB still yields one index page) ─

const totalPages = Math.max(1, Math.ceil(hosts.length / PAGE_SIZE));
for (let p = 1; p <= totalPages; p++) {
	const pageHosts = hosts.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
	const mainInner = renderIndexMain(pageHosts, p, totalPages);
	await writePage(pageFileName(p), snippetFileName(p), mainInner, TITLE, headerText);
}

// ── Per-host pages ─────────────────────────────────────────────────────────────

for (const host of hosts) {
	const mainInner = renderHostMain(host);
	await writePage(`${host.slug}.html`, `${host.slug}.html`, mainInner, `${host.displayName} | ${TITLE}`, headerText);
}

const images = new Set(imgByKey.values()).size;
console.log(
	`Wrote ${OUT_DIR}/: ${hosts.length} host(s) across ${totalPages} index page(s), ` +
		`${hosts.length} host page(s), ${images} image(s). Run \`bun run serve\`.`,
);
