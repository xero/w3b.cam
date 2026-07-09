// Visualizer: read the SQLite DB and write a paginated multi-file static site.
// Screenshots are extracted to files under out/img/ (deduped by content hash) and
// referenced by <img src>. Every page is emitted twice: the full HTML document and
// a snippet (the inner-<main> content) that htmx swaps in for SPA-like navigation.
// The two are derived from the same string, so they can never drift.
//
// Usage:  bun run bake   (then: bun run serve)

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import {
	ASSETS_DIR,
	HLS_OUT,
	HLS_VENDOR_SRC,
	HTMX_OUT,
	HTMX_VENDOR_SRC,
	IMG_DIR,
	OUT_DIR,
	PAGE_SIZE,
	SNIPS_DIR,
	TAG_PAGE_SIZE,
	TRAFFIC_PAGE_SIZE,
	YT_PAGE_SIZE,
} from "./config.ts";
import { allRows, allTrafficRows, allYtRows, closeDb, loadFeatured, loadTagCounts, loadTagIndex, loadTags, loadYtGeo, openDb } from "./db.ts";
import { isBlockedProduct } from "./util.ts";
import {
	extFromMime,
	groupByIp,
	hostSnippetUrl,
	hostUrl,
	mapPageFileName,
	mapSnippetFileName,
	pageFileName,
	project,
	renderHomeMain,
	renderHostMain,
	renderIndexMain,
	renderMapMain,
	renderShell,
	renderTagBrowseMain,
	renderTagsMain,
	renderTrafficDetail,
	renderTrafficMain,
	renderYtDetail,
	renderYtMain,
	snippetFileName,
	streamsPageFileName,
	streamsSnippetFileName,
	tagBrowsePageFileName,
	tagBrowseSnippetFileName,
	tagSlug,
	tagsPageFileName,
	tagsSnippetFileName,
	TITLE,
	toTrafficCam,
	toYtStream,
	trafficDetailSnippetUrl,
	trafficPageFileName,
	trafficSnippetFileName,
	trafficUrl,
	ytSnippetUrl,
	ytUrl,
	type Host,
	type MapPoint,
	type TagItem,
	type TrafficCam,
	type YtStream,
} from "./render.ts";
import type { StoredRow, StoredTrafficRow, StoredYtRow } from "./types.ts";

/**
 * Decode each row's screenshot to a file under out/img/ (deduped by content
 * hash) and return a map from the row's key to its image URL. Rows with no
 * stored image are skipped (a YouTube thumbnail fetch can fail), so their key is
 * absent and the caller renders a placeholder. `written` is shared across calls
 * so the webcam and YouTube passes dedupe against each other and the final image
 * count is accurate.
 */
async function extractImages<T>(
	rows: T[],
	key: (row: T) => string,
	ssBase64: (row: T) => string | null,
	ssMime: (row: T) => string | null,
	written: Set<string>,
): Promise<Map<string, string>> {
	const byKey = new Map<string, string>();
	for (const r of rows) {
		const b64 = ssBase64(r);
		if (!b64) continue;
		// Same base64 cleanup the single-page build did: strip any line wrapping.
		const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
		const buf = Buffer.from(clean, "base64");
		if (buf.length === 0) continue;
		const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
		const name = `${hash}.${extFromMime(ssMime(r) ?? "")}`;
		if (!written.has(name)) {
			await Bun.write(`${IMG_DIR}/${name}`, buf);
			written.add(name);
		}
		byKey.set(key(r), `/img/${name}`);
	}
	return byKey;
}

async function writePage(fullName: string, snipName: string, mainInner: string, title: string, headerText: string, opts: { dev?: boolean } = {}): Promise<void> {
	await Bun.write(`${OUT_DIR}/${fullName}`, renderShell({ title, headerText, mainInner, dev: opts.dev }));
	await Bun.write(`${SNIPS_DIR}/${snipName}`, `${mainInner}\n`);
}

/** Cards shown per kind on the homepage: the featured pins first, then the newest fill the rest. */
const HOME_PER_KIND = 4;

/**
 * Assemble one homepage row: resolve the featured `refs` against `byRef` (a pin
 * whose row is gone is skipped), then top up from `newest` until `limit` cards,
 * never repeating one (`keyOf` dedupes featured vs newest). With two live pins and
 * `newest` sorted newest-first, this yields the two featured then the two newest.
 */
function pickHome<T>(refs: string[], byRef: Map<string, T>, newest: T[], keyOf: (item: T) => string, limit: number): T[] {
	const picked: T[] = [];
	const used = new Set<string>();
	const take = (item: T | undefined): void => {
		if (!item || picked.length >= limit) return;
		const k = keyOf(item);
		if (used.has(k)) return;
		used.add(k);
		picked.push(item);
	};
	for (const ref of refs) take(byRef.get(ref));
	for (const item of newest) take(item);
	return picked;
}

/**
 * Read the DB and write the paginated static site into out/. `dev` bakes the
 * in-browser editing hooks (data-* attributes on cards/shots) and the dev client
 * into every page; off (the default) yields the byte-identical production site.
 * `bun bake` calls this with no options; `bun dev` (src/dev.ts) passes `{ dev: true }`.
 */
export async function build(opts: { dev?: boolean } = {}): Promise<void> {
	const dev = opts.dev ?? false;

	// ── Load ──────────────────────────────────────────────────────────────────────

	const db = openDb();
	let rows: StoredRow[];
	let tagsByIp: Map<string, string[]>;
	let tagsByVideo: Map<string, string[]>;
	let tagsByTraffic: Map<string, string[]>;
	let tagCounts: { tag: string; count: number }[];
	let tagIndex: Map<string, { kind: "cam" | "stream" | "traffic"; ref: string }[]>;
	let ytRows: StoredYtRow[];
	let ytGeo: Map<string, { lat: number; lng: number }>;
	let trafficRows: StoredTrafficRow[];
	let featured: { cams: string[]; streams: string[] };
	try {
		// Blocked products (RDP/VNC) are filtered at ingestion, but rows that predate
		// that guard can still be in the DB. Never render them, whatever the DB holds.
		rows = allRows(db).filter((r) => !isBlockedProduct(r.product));
		tagsByIp = loadTags(db, "cam");
		tagsByVideo = loadTags(db, "stream");
		tagsByTraffic = loadTags(db, "traffic");
		tagCounts = loadTagCounts(db);
		tagIndex = loadTagIndex(db);
		ytRows = allYtRows(db);
		ytGeo = loadYtGeo(db);
		trafficRows = allTrafficRows(db);
		featured = loadFeatured(db);
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

	// Vendor hls.js too (fetched on demand by assets/traffic.js when an HLS cam is
	// viewed). A missing copy only breaks HLS playback, so warn rather than abort.
	if (await Bun.file(HLS_VENDOR_SRC).exists()) {
		await Bun.write(HLS_OUT, Bun.file(HLS_VENDOR_SRC));
	} else {
		console.warn(`Missing ${HLS_VENDOR_SRC}; HLS traffic cams will fall back to their "View live" link. Run \`bun install\`.`);
	}

	// Copy static assets (favicons, web manifest) verbatim into out/ root, the
	// same flat copy the htmx write above does. Guard on the dir so a missing
	// assets/ warns instead of aborting the bake (mirrors the htmx guard).
	// existsSync (not Bun.file().exists()) since ASSETS_DIR is a directory.
	if (existsSync(ASSETS_DIR)) {
		for (const ent of await readdir(ASSETS_DIR, { withFileTypes: true })) {
			if (ent.isFile()) await Bun.write(`${OUT_DIR}/${ent.name}`, Bun.file(`${ASSETS_DIR}/${ent.name}`));
		}
	} else {
		console.warn(`No ${ASSETS_DIR}/ dir; skipping favicon/manifest copy.`);
	}

	// ── Build the grouped model ──────────────────────────────────────────────────

	const written = new Set<string>();
	const imgByKey = await extractImages(
		rows,
		(r) => `${r.ip_str}:${r.port}`,
		(r) => r.ss_base64,
		(r) => r.ss_mime,
		written,
	);
	const imgHref = (row: StoredRow): string => imgByKey.get(`${row.ip_str}:${row.port}`) ?? "";
	const hosts: Host[] = groupByIp(rows, imgHref, tagsByIp);

	const headerText = `${hosts.length.toLocaleString()} ${hosts.length === 1 ? "host" : "hosts"} · ${rows.length.toLocaleString()} ${rows.length === 1 ? "camera" : "cameras"}`;

	// Deduped tag -> slug map: the single source of truth for tag-browse URLs. Two
	// distinct tags can slug identically, so a suffix loop keeps their files apart
	// (mirrors how groupByIp disambiguates host slugs). Detail pages and the cloud
	// both link through slugForTag so a link can never miss its page.
	const tagSlugs = new Map<string, string>();
	const usedSlugs = new Set<string>();
	for (const { tag } of tagCounts) {
		const base = tagSlug(tag);
		let slug = base;
		for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
		usedSlugs.add(slug);
		tagSlugs.set(tag, slug);
	}
	const slugForTag = (tag: string): string => tagSlugs.get(tag) ?? tagSlug(tag);

	// ── Paginated cams gallery (page 1 is page001.html; empty DB still yields one page) ─

	const totalPages = Math.max(1, Math.ceil(hosts.length / PAGE_SIZE));
	for (let p = 1; p <= totalPages; p++) {
		const pageHosts = hosts.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
		const mainInner = renderIndexMain(pageHosts, p, totalPages, { dev });
		await writePage(pageFileName(p), snippetFileName(p), mainInner, TITLE, headerText, { dev });
	}

	// ── Per-host pages ─────────────────────────────────────────────────────────────

	for (const host of hosts) {
		const mainInner = renderHostMain(host, { dev, slugForTag });
		await writePage(`${host.slug}.html`, `${host.slug}.html`, mainInner, `${host.displayName} | ${TITLE}`, headerText, { dev });
	}

	// ── YouTube streams: flat gallery (every stream) + per-video detail pages ────────

	const ytImgById = await extractImages(
		ytRows,
		(r) => r.video_id,
		(r) => r.ss_base64,
		(r) => r.ss_mime,
		written,
	);
	const streams: YtStream[] = ytRows.map((r) => toYtStream(r, ytImgById.get(r.video_id) ?? "", tagsByVideo.get(r.video_id) ?? []));

	// Group by channel so each detail page can link its "More from this channel" siblings.
	const streamsByChannel = new Map<string, YtStream[]>();
	for (const s of streams) {
		if (!s.channelId) continue;
		const list = streamsByChannel.get(s.channelId);
		if (list) list.push(s);
		else streamsByChannel.set(s.channelId, [s]);
	}

	const ytHeaderText = `${streams.length.toLocaleString()} ${streams.length === 1 ? "stream" : "streams"}`;

	// ── Traffic (Osiris) cams: baked thumbnails + view models ────────────────────────
	// Same hybrid pipeline as the other sources for the card image (a baked, deduped
	// thumbnail); the live feed itself is embedded client-side on the detail page.
	const trafficImgById = await extractImages(
		trafficRows,
		(r) => r.id,
		(r) => r.ss_base64,
		(r) => r.ss_mime,
		written,
	);
	const trafficCams: TrafficCam[] = trafficRows.map((r) => toTrafficCam(r, trafficImgById.get(r.id) ?? "", tagsByTraffic.get(r.id) ?? []));
	const trafficHeaderText = `${trafficCams.length.toLocaleString()} ${trafficCams.length === 1 ? "cam" : "cams"}`;

	// ── Homepage (index.html): two featured + two newest of each kind ────────────────

	// `hosts` is already newest-first (groupByIp). Streams sort newest-first by
	// first_seen (then published_at, then video_id) for a stable "newest" order.
	const camByIp = new Map(hosts.map((h) => [h.ip, h]));
	const streamByVideo = new Map(streams.map((s) => [s.videoId, s]));
	const newestStreams = [...ytRows]
		.sort((a, b) => {
			if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen ? 1 : -1;
			const ap = a.published_at ?? "";
			const bp = b.published_at ?? "";
			if (ap !== bp) return ap < bp ? 1 : -1;
			return a.video_id < b.video_id ? -1 : 1;
		})
		.map((r) => streamByVideo.get(r.video_id))
		.filter((s): s is YtStream => s !== undefined);

	// Traffic has no featured pins yet (deferred), so the homepage shows its newest.
	const trafficById = new Map(trafficCams.map((c) => [c.id, c]));
	const newestTraffic = [...trafficRows]
		.sort((a, b) => {
			// Cams with a baked thumbnail first, so the homepage never leads with black tiles.
			const at = a.ss_base64 ? 0 : 1;
			const bt = b.ss_base64 ? 0 : 1;
			if (at !== bt) return at - bt;
			if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen ? 1 : -1;
			return a.id < b.id ? -1 : 1;
		})
		.map((r) => trafficById.get(r.id))
		.filter((c): c is TrafficCam => c !== undefined);

	const homeCams = pickHome(featured.cams, camByIp, hosts, (h) => h.ip, HOME_PER_KIND);
	const homeStreams = pickHome(featured.streams, streamByVideo, newestStreams, (s) => s.videoId, HOME_PER_KIND);
	const homeTraffic = newestTraffic.slice(0, HOME_PER_KIND);
	const homeHeaderText =
		`${headerText} · ${streams.length.toLocaleString()} ${streams.length === 1 ? "stream" : "streams"}` +
		` · ${trafficCams.length.toLocaleString()} traffic`;
	await writePage("index.html", "index.html", renderHomeMain(homeCams, homeStreams, homeTraffic, { dev }), TITLE, homeHeaderText, { dev });

	const ytTotalPages = Math.max(1, Math.ceil(streams.length / YT_PAGE_SIZE));
	for (let p = 1; p <= ytTotalPages; p++) {
		const pageStreams = streams.slice((p - 1) * YT_PAGE_SIZE, p * YT_PAGE_SIZE);
		const mainInner = renderYtMain(pageStreams, p, ytTotalPages, { dev });
		await writePage(streamsPageFileName(p), streamsSnippetFileName(p), mainInner, `streams | ${TITLE}`, ytHeaderText, { dev });
	}

	for (const s of streams) {
		const siblings = s.channelId ? (streamsByChannel.get(s.channelId) ?? [s]) : [s];
		const mainInner = renderYtDetail(s, siblings, { dev, slugForTag });
		await writePage(`${s.slug}.html`, `${s.slug}.html`, mainInner, `${s.label} | ${TITLE}`, ytHeaderText, { dev });
	}

	// ── Traffic cams: paginated gallery + per-cam detail pages ────────────────────────

	const trafficTotalPages = Math.max(1, Math.ceil(trafficCams.length / TRAFFIC_PAGE_SIZE));
	for (let p = 1; p <= trafficTotalPages; p++) {
		const pageCams = trafficCams.slice((p - 1) * TRAFFIC_PAGE_SIZE, p * TRAFFIC_PAGE_SIZE);
		const mainInner = renderTrafficMain(pageCams, p, trafficTotalPages, { dev });
		await writePage(trafficPageFileName(p), trafficSnippetFileName(p), mainInner, `traffic | ${TITLE}`, trafficHeaderText, { dev });
	}

	for (const cam of trafficCams) {
		const mainInner = renderTrafficDetail(cam, { dev, slugForTag });
		await writePage(`${cam.slug}.html`, `${cam.slug}.html`, mainInner, `${cam.name} | ${TITLE}`, trafficHeaderText, { dev });
	}

	// ── Tags cloud (linked from the nav; each tag links to its browse page below) ────

	const tagsHeaderText = `${tagCounts.length.toLocaleString()} ${tagCounts.length === 1 ? "tag" : "tags"}`;
	await writePage(tagsPageFileName, tagsSnippetFileName, renderTagsMain(tagCounts, slugForTag), `tags | ${TITLE}`, tagsHeaderText, { dev });

	// ── Tag browse pages: one paginated, blended gallery per tag ─────────────────────
	// Resolve each tagged (kind, ref) against the in-memory view models via the maps
	// built above, keeping each kind's native newest-first order. Only cams can go
	// missing (blocked/blacklisted, or an IP tagged with no stored cameras); streams
	// and traffic always resolve. A tag whose refs are all gone still gets a page (its
	// cloud link must not 404), rendered as the empty state.
	let tagPagesWritten = 0;
	for (const { tag } of tagCounts) {
		const slug = slugForTag(tag);
		const entries = tagIndex.get(tag) ?? [];
		const camRefs = new Set(entries.filter((e) => e.kind === "cam").map((e) => e.ref));
		const streamRefs = new Set(entries.filter((e) => e.kind === "stream").map((e) => e.ref));
		const trafficRefs = new Set(entries.filter((e) => e.kind === "traffic").map((e) => e.ref));
		const items: TagItem[] = [
			...hosts.filter((h) => camRefs.has(h.ip)).map((h): TagItem => ({ kind: "cam", host: h })),
			...streams.filter((s) => streamRefs.has(s.videoId)).map((s): TagItem => ({ kind: "stream", stream: s })),
			...trafficCams.filter((c) => trafficRefs.has(c.id)).map((c): TagItem => ({ kind: "traffic", cam: c })),
		];
		const tagTotalPages = Math.max(1, Math.ceil(items.length / TAG_PAGE_SIZE));
		const tagHeaderText = `#${tag} · ${items.length.toLocaleString()} tagged`;
		for (let p = 1; p <= tagTotalPages; p++) {
			const pageItems = items.slice((p - 1) * TAG_PAGE_SIZE, p * TAG_PAGE_SIZE);
			const mainInner = renderTagBrowseMain(tag, pageItems, p, tagTotalPages, slug, { dev, slugForTag });
			await writePage(tagBrowsePageFileName(slug, p), tagBrowseSnippetFileName(slug, p), mainInner, `#${tag} | ${TITLE}`, tagHeaderText, { dev });
			tagPagesWritten++;
		}
	}

	// ── World map: a dot per geolocated camera across all three sources ──────────────
	// Shodan hosts carry coarse geo-IP coords, traffic cams precise ones, and YouTube
	// streams only whatever we hand-assigned in yt_geo; a source lacking a coord is
	// simply skipped. Each dot links to that cam's existing detail page.
	const loc = (...parts: (string | null)[]): string =>
		parts.filter((v): v is string => !!v && v.trim() !== "").join(", ");
	const mapPoints: MapPoint[] = [];
	for (const h of hosts) {
		if (h.latitude == null || h.longitude == null) continue;
		const { x, y } = project(h.latitude, h.longitude);
		mapPoints.push({ x, y, href: hostUrl(h.slug), snip: hostSnippetUrl(h.slug), title: loc(h.city, h.country_name) || h.displayName });
	}
	for (const c of trafficCams) {
		if (c.lat == null || c.lng == null) continue;
		const { x, y } = project(c.lat, c.lng);
		mapPoints.push({ x, y, href: trafficUrl(c.slug), snip: trafficDetailSnippetUrl(c.slug), title: loc(c.city, c.country) || c.name });
	}
	for (const s of streams) {
		const g = ytGeo.get(s.videoId);
		if (!g) continue;
		const { x, y } = project(g.lat, g.lng);
		mapPoints.push({ x, y, href: ytUrl(s.slug), snip: ytSnippetUrl(s.slug), title: s.label });
	}
	await writePage(mapPageFileName, mapSnippetFileName, renderMapMain(mapPoints, mapPoints.length), `map | ${TITLE}`, homeHeaderText, { dev });

	const images = written.size;
	console.log(
		`Wrote ${OUT_DIR}/: homepage + ${hosts.length} host(s) across ${totalPages} cams page(s), ` +
			`${hosts.length} host page(s), ${streams.length} stream(s) across ${ytTotalPages} streams page(s), ` +
			`${trafficCams.length} traffic cam(s) across ${trafficTotalPages} traffic page(s), ` +
			`map (${mapPoints.length.toLocaleString()} dot(s)), tags cloud + ${tagPagesWritten} browse page(s) across ${tagCounts.length} tag(s), ${images} image(s).${dev ? " (dev build)" : " Run `bun run serve`."}`,
	);
}

// Direct run (`bun run bake` / `bun run src/build.ts`) bakes the production site.
if (import.meta.main) await build();
