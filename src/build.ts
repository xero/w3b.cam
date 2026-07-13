// Visualizer: read the SQLite DB and write a folder-based static site into out/.
// Screenshots are extracted to files under out/img/ (deduped by content hash) and
// referenced by <img src>. Every page is emitted twice into the same folder: the full
// HTML document (index.html) and a co-located snippet (index.snippet.html, the inner-
// <main> content) that htmx swaps in for SPA-like navigation. The two are derived from
// the same string, so they can never drift. Clean URLs throughout: /gallery/1, not
// /gallery/1.html (see src/urls.ts for the route model; src/serve.ts resolves them).
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
	MANIFEST,
	OUT_DIR,
	PAGE_SIZE,
	SYNDICATION_LIMIT,
	TAG_PAGE_SIZE,
	FEED_PAGE_SIZE,
	YT_PAGE_SIZE,
} from "./config.ts";
import { computeAutoTags } from "./autotags.ts";
import { allRows, allRowsMeta, allFeedRows, allFeedRowsMeta, allYtRows, allYtRowsMeta, closeDb, loadFeatured, loadTagCounts, loadTagIndex, loadTags, loadVendorRefs, loadYtGeo, openDb, type TagKind } from "./db.ts";
import { productBreakdown } from "./fingerprint.ts";
import { isBlockedProduct, pickRandom } from "./util.ts";
import {
	extFromMime,
	groupByIp,
	project,
	renderFingerprintsMain,
	renderGalleryMain,
	renderHomeMain,
	renderHostMain,
	renderImportForm,
	renderImportMain,
	renderIndexMain,
	renderMapMain,
	renderShell,
	renderTagBrowseMain,
	renderTagsMain,
	renderTipsMain,
	renderFeedDetail,
	renderFeedMain,
	renderVendorMain,
	renderYtDetail,
	renderYtMain,
	TITLE,
	toFeedCam,
	toYtStream,
	type Host,
	type MapPoint,
	type SiteStats,
	type TagItem,
	type FeedCam,
	type YtStream,
} from "./render.ts";
import { hostToFeedItem, renderAtom, renderRss } from "./syndication.ts";
import {
	diskOf,
	snipDiskOf,
	snipUrlOf,
	urlOf,
	FEEDS,
	FINGERPRINTS,
	GALLERY,
	HOME,
	HOSTS,
	IMPORT,
	MAP,
	STREAMS,
	TAGS,
	TIPS,
	feedRoute,
	feedSlug,
	feedsPage,
	galleryPage,
	hostRoute,
	hostsPage,
	importFormSnippetDisk,
	streamRoute,
	streamsPage,
	tagPage,
	tagRoute,
	tagSlug,
	vendorPage,
	vendorRoute,
} from "./urls.ts";
import type { StoredRow, StoredFeedRow, StoredYtRow } from "./types.ts";

/** Scrape workflow, read at build time so the site surfaces its own cron cadence. */
const SCRAPE_WORKFLOW = ".github/workflows/scrape.yml";
/** Cadence shown when the workflow is missing or its cron is unrecognized. */
const DEFAULT_INTERVAL = "6 hrs";

/** Build time as "YYYY-MM-DD @ HH:MM" in UTC (the CI bake runs in UTC). */
function formatBuiltAt(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} @ ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Human cadence from a 5-field cron: a step in the hour field ("0 */6 * * *")
// yields "6 hrs"; a step in the minute field ("*/30 * * * *") yields "30 min"; a
// single fixed hour yields "24 hrs". Returns null if unrecognized.
function cronToInterval(expr: string): string | null {
	const f = expr.trim().split(/\s+/);
	const min = f[0];
	const hour = f[1];
	if (!min || !hour) return null;
	if (hour.startsWith("*/")) {
		const n = Number(hour.slice(2));
		if (n > 0) return `${n} hr${n === 1 ? "" : "s"}`;
	}
	if (hour === "*" && min.startsWith("*/")) {
		const n = Number(min.slice(2));
		if (n > 0) return `${n} min`;
	}
	if (hour === "*") return "1 hr";
	if (/^\d+$/.test(hour)) return "24 hrs";
	return null;
}

/**
 * Human refresh cadence derived from the scrape workflow's cron, so the header
 * self-updates if the schedule changes. Reads the first `cron:` line with a regex
 * (the repo has no YAML dep) and falls back to the documented six hours.
 */
async function readScrapeInterval(): Promise<string> {
	try {
		const yml = await Bun.file(SCRAPE_WORKFLOW).text();
		const expr = yml.match(/cron:\s*['"]([^'"]+)['"]/)?.[1];
		return (expr && cronToInterval(expr)) || DEFAULT_INTERVAL;
	} catch {
		return DEFAULT_INTERVAL;
	}
}

/**
 * Decode each row's screenshot to a file under out/img/ (deduped by content
 * hash) and return a map from the row's key to its image URL. Rows with no
 * stored image are skipped (a YouTube thumbnail fetch can fail), so their key is
 * absent and the caller renders a placeholder. `written` is shared across calls
 * so the webcam and YouTube passes dedupe against each other and the final image
 * count is accurate.
 */
/** The three id→url image maps a build resolves, serialized for `--index-only` reuse. */
type ImgManifest = { cams: Map<string, string>; streams: Map<string, string>; feeds: Map<string, string> };

/** Persist the resolved image URLs so a later `--index-only` build reuses the on-disk
 *  screenshots without re-decoding and re-hashing every row. Written on every full bake. */
async function writeManifest(m: ImgManifest): Promise<void> {
	const obj = { cams: Object.fromEntries(m.cams), streams: Object.fromEntries(m.streams), feeds: Object.fromEntries(m.feeds) };
	await Bun.write(MANIFEST, JSON.stringify(obj));
}

/** Load the image manifest a prior full bake wrote, or null if it is missing or unreadable
 *  (which sends `--index-only` down a one-time full build instead of failing). */
async function loadManifest(): Promise<ImgManifest | null> {
	try {
		const raw = await Bun.file(MANIFEST).json();
		return {
			cams: new Map(Object.entries(raw.cams ?? {}) as [string, string][]),
			streams: new Map(Object.entries(raw.streams ?? {}) as [string, string][]),
			feeds: new Map(Object.entries(raw.feeds ?? {}) as [string, string][]),
		};
	} catch {
		return null;
	}
}

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

/**
 * Write one page: the full document to OUT_DIR/<route>/index.html and its co-located
 * snippet to OUT_DIR/<route>/index.snippet.html (root route -> OUT_DIR/index.html and
 * index.snippet.html). Both come from the same `mainInner`, so they never drift.
 */
async function writePage(route: string, mainInner: string, title: string, stats: SiteStats, opts: { dev?: boolean } = {}): Promise<void> {
	await Bun.write(`${OUT_DIR}/${diskOf(route)}`, renderShell({ title, stats, mainInner, dev: opts.dev }));
	await Bun.write(`${OUT_DIR}/${snipDiskOf(route)}`, `${mainInner}\n`);
}

/** Cards shown per kind on the homepage: the featured picks first, then the newest fill the rest. */
const HOME_PER_KIND = 4;

/** How many of the HOME_PER_KIND cards are sampled at random from the featured set each build (rest fill from newest). */
const HOME_FEATURED_PER_KIND = 2;

/** Rows shown in each homepage "top N" column (most-used tags, most-common cam makes). */
const HOME_TOP_N = 10;

/**
 * The set of vendors that will get a `/fingerprints/<vendor>` gallery this build: a vendor
 * qualifies iff it has at least one visible host or feed. Computed straight from vendorRefs +
 * the already-filtered `hosts`/`feedCams` (both carry only rows with a screenshot), so it is
 * available before the --index-only early return — and matches the emptiness check the
 * vendor-gallery loop makes when it actually writes the pages.
 */
function computeVendorsWithGallery(
	vendorRefs: { byVendor: Map<string, { hosts: Set<string>; feeds: Set<string> }> },
	hosts: Host[],
	feedCams: FeedCam[],
): Set<string> {
	const visibleHostIps = new Set(hosts.map((h) => h.ip));
	const visibleFeedIds = new Set(feedCams.map((c) => c.id));
	const out = new Set<string>();
	for (const [vendor, refs] of vendorRefs.byVendor) {
		const has =
			[...refs.hosts].some((ip) => visibleHostIps.has(ip)) || [...refs.feeds].some((id) => visibleFeedIds.has(id));
		if (has) out.add(vendor);
	}
	return out;
}

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

/** Newest-first comparator for the blended `{ ts, item }` gallery entries (ISO timestamps sort lexically). */
const byNewest = (a: { ts: string }, b: { ts: string }): number => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);

/**
 * Read the DB and write the folder-based static site into out/. `dev` bakes the
 * in-browser editing hooks (data-* attributes on cards/shots) and the dev client
 * into every page; off (the default) yields the byte-identical production site.
 * `bun bake` calls this with no options; `bun dev` (src/dev.ts) passes `{ dev: true }`.
 */
export async function build(opts: { dev?: boolean; indexOnly?: boolean } = {}): Promise<void> {
	const dev = opts.dev ?? false;

	// --index-only regenerates just index.html against the last full bake's out/ (images
	// + all other pages reused as-is), for a fast `bun dev` restart. It needs the image
	// manifest a full bake writes; without it, fall back to a normal full build once.
	let indexOnly = opts.indexOnly ?? false;
	let manifest: ImgManifest | null = null;
	if (indexOnly) {
		manifest = await loadManifest();
		if (!manifest) {
			console.warn(`--index-only: no ${MANIFEST} (run a full \`bun bake\`/\`bun dev\` first); doing a full build this once.`);
			indexOnly = false;
		}
	}

	// ── Load ──────────────────────────────────────────────────────────────────────

	const db = openDb();
	let rows: StoredRow[];
	let tagsByIp: Map<string, string[]>;
	let tagsByVideo: Map<string, string[]>;
	let tagsByFeed: Map<string, string[]>;
	let tagCounts: { tag: string; count: number }[];
	let tagIndex: Map<string, { kind: "cam" | "stream" | "feed"; ref: string }[]>;
	let ytRows: StoredYtRow[];
	let ytGeo: Map<string, { lat: number; lng: number }>;
	let feedRows: StoredFeedRow[];
	let featured: { cams: string[]; streams: string[]; feeds: string[] };
	let vendorRefs: { byVendor: Map<string, { hosts: Set<string>; feeds: Set<string> }>; byRef: Map<string, string> };
	try {
		// The site never renders a blank card, whatever the DB holds, so every kind is
		// filtered to rows that carry a screenshot. Feeds are the usual offender: an
		// ingest can leave a row whose grab was blocked/dead (see the ingesters, which now
		// also decline to write those). Blocked products (RDP/VNC) are dropped too: they
		// are filtered at ingestion, but rows predating that guard can still be stored.
		// (--index-only reads ss_base64 as a truthy '1' sentinel, so this filter still works.)
		rows = (indexOnly ? allRowsMeta(db) : allRows(db)).filter((r) => r.ss_base64 && !isBlockedProduct(r.product));
		tagsByIp = loadTags(db, "cam");
		tagsByVideo = loadTags(db, "stream");
		tagsByFeed = loadTags(db, "feed");
		tagCounts = loadTagCounts(db);
		tagIndex = loadTagIndex(db);
		ytRows = (indexOnly ? allYtRowsMeta(db) : allYtRows(db)).filter((r) => r.ss_base64);
		ytGeo = loadYtGeo(db);
		feedRows = (indexOnly ? allFeedRowsMeta(db) : allFeedRows(db)).filter((r) => r.ss_base64);
		featured = loadFeatured(db);
		vendorRefs = loadVendorRefs(db);
	} finally {
		closeDb(db);
	}

	// ── Wipe and recreate out/ from scratch ─────────────────────────────────────────
	// Skipped for --index-only: it reuses the last full bake's out/ (images + every page
	// but the homepage), so wiping and re-copying vendored assets would defeat the point.

	if (!indexOnly) {
		await rm(OUT_DIR, { recursive: true, force: true });

		if (!(await Bun.file(HTMX_VENDOR_SRC).exists())) {
			console.error(`Missing ${HTMX_VENDOR_SRC}. Run \`bun install\` first.`);
			process.exit(1);
		}
		await Bun.write(HTMX_OUT, Bun.file(HTMX_VENDOR_SRC));

		// Vendor hls.js too (fetched on demand by assets/feeds.js when an HLS cam is
		// viewed). A missing copy only breaks HLS playback, so warn rather than abort.
		if (await Bun.file(HLS_VENDOR_SRC).exists()) {
			await Bun.write(HLS_OUT, Bun.file(HLS_VENDOR_SRC));
		} else {
			console.warn(`Missing ${HLS_VENDOR_SRC}; HLS feed cams will fall back to their "View live" link. Run \`bun install\`.`);
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
	}

	// ── Build the grouped model ──────────────────────────────────────────────────

	// --index-only takes the image URLs straight from the manifest (already on disk); a
	// full bake extracts them from the screenshot bytes and writes the manifest below.
	const written = new Set<string>();
	const imgByKey = indexOnly
		? manifest!.cams
		: await extractImages(rows, (r) => `${r.ip_str}:${r.port}`, (r) => r.ss_base64, (r) => r.ss_mime, written);
	const imgHref = (row: StoredRow): string => imgByKey.get(`${row.ip_str}:${row.port}`) ?? "";
	const hosts: Host[] = groupByIp(rows, imgHref, tagsByIp);

	// One camera-wide stat block, identical on every page: the combined total across
	// all three DB sources (cams + streams + feed), the build time, and the scrape
	// cadence. streams/feedCams (built below) are 1:1 maps of ytRows/feedRows, so
	// the raw row counts here are the source-of-truth totals.
	const stats: SiteStats = {
		discovered: (rows.length + ytRows.length + feedRows.length).toLocaleString(),
		updated: formatBuiltAt(new Date()),
		interval: await readScrapeInterval(),
	};

	// Deduped tag -> slug map: the single source of truth for tag-browse URLs. Two
	// distinct tags can slug identically, so a suffix loop keeps their folders apart
	// (mirrors how groupByIp disambiguates host slugs). Detail pages and the cloud
	// both link through slugForTag so a link can never miss its page.
	const tagSlugs = new Map<string, string>();
	const usedTagSlugs = new Set<string>();
	for (const { tag } of tagCounts) {
		const base = tagSlug(tag);
		let slug = base;
		for (let n = 2; usedTagSlugs.has(slug); n++) slug = `${base}-${n}`;
		usedTagSlugs.add(slug);
		tagSlugs.set(tag, slug);
	}
	const slugForTag = (tag: string): string => tagSlugs.get(tag) ?? tagSlug(tag);

	// ── YouTube streams: view models + channel grouping ──────────────────────────────

	const ytImgById = indexOnly
		? manifest!.streams
		: await extractImages(ytRows, (r) => r.id, (r) => r.ss_base64, (r) => r.ss_mime, written);
	const streams: YtStream[] = ytRows.map((r) => toYtStream(r, ytImgById.get(r.id) ?? "", tagsByVideo.get(r.id) ?? []));

	// Group by channel so each detail page can link its "More from this channel" siblings.
	const streamsByChannel = new Map<string, YtStream[]>();
	for (const s of streams) {
		if (!s.channelId) continue;
		const list = streamsByChannel.get(s.channelId);
		if (list) list.push(s);
		else streamsByChannel.set(s.channelId, [s]);
	}

	// ── Feeds (ex-"feed"): baked thumbnails + view models ─────────────────────────
	// Same hybrid pipeline as the other sources for the card image (a baked, deduped
	// thumbnail); the live feed itself is embedded client-side on the detail page.
	const feedImgById = indexOnly
		? manifest!.feeds
		: await extractImages(feedRows, (r) => r.id, (r) => r.ss_base64, (r) => r.ss_mime, written);

	// Persist the resolved URLs so the next --index-only build can reuse the on-disk images.
	if (!indexOnly) await writeManifest({ cams: imgByKey, streams: ytImgById, feeds: feedImgById });
	// Deduped feed folder slugs. feedSlug strips the `mjpeg-` prefix so those read like an
	// IP; ids are the PK (unique), so a collision can only arise from that strip. A suffix
	// loop guards it anyway, mirroring the host/tag dedup, so a page can never overwrite another.
	const feedSlugs = new Map<string, string>();
	const usedFeedSlugs = new Set<string>();
	for (const r of feedRows) {
		const base = feedSlug(r.id);
		let slug = base;
		for (let n = 2; usedFeedSlugs.has(slug); n++) slug = `${base}-${n}`;
		usedFeedSlugs.add(slug);
		feedSlugs.set(r.id, slug);
	}
	const feedCams: FeedCam[] = feedRows.map((r) => toFeedCam(r, feedImgById.get(r.id) ?? "", tagsByFeed.get(r.id) ?? [], feedSlugs.get(r.id)));

	// ── Auto-tags: derived metadata merged into the cloud (not the DB, not the homepage) ──
	// Computed from the grouped view models above; each becomes a cloud entry + browse gallery
	// via the same machinery as hand tags. They deliberately never reach `topTags` (below), so
	// their huge counts can't clobber the homepage's top-tags column. See autotags.ts.
	const autoTags = computeAutoTags(hosts, feedCams);
	const autoTagIndex = new Map<string, { kind: TagKind; ref: string }[]>(autoTags.map((a) => [a.tag, a.refs]));
	const autoTagCounts = autoTags.map((a) => ({ tag: a.tag, count: a.refs.length, auto: true }));
	// Give each auto-tag a browse slug, reusing the dedup set so it can't collide with a hand tag.
	for (const { tag } of autoTagCounts) {
		const base = tagSlug(tag);
		let slug = base;
		for (let n = 2; usedTagSlugs.has(slug); n++) slug = `${base}-${n}`;
		usedTagSlugs.add(slug);
		tagSlugs.set(tag, slug);
	}
	// Cloud order: hand tags + auto-tags, re-sorted so auto-tags interleave alphabetically.
	const cloudTags = [...tagCounts, ...autoTagCounts].sort((a, b) => a.tag.localeCompare(b.tag));

	// ── Homepage (index.html): two featured + two newest of each kind ────────────────
	// Rendered before the galleries so --index-only can write just this page and return,
	// reusing the rest of out/ from the last full bake.

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
			return a.id < b.id ? -1 : 1;
		})
		.map((r) => streamByVideo.get(r.id))
		.filter((s): s is YtStream => s !== undefined);

	const feedById = new Map(feedCams.map((c) => [c.id, c]));
	const newestFeeds = [...feedRows]
		.sort((a, b) => {
			// Cams with a baked thumbnail first, so the homepage never leads with black tiles.
			const at = a.ss_base64 ? 0 : 1;
			const bt = b.ss_base64 ? 0 : 1;
			if (at !== bt) return at - bt;
			if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen ? 1 : -1;
			return a.id < b.id ? -1 : 1;
		})
		.map((r) => feedById.get(r.id))
		.filter((c): c is FeedCam => c !== undefined);

	// Resolve featured refs to live rows, then drop the newest that will fill the rest of
	// the row: a random featured pick must never land on a card that's about to show as
	// "newest" anyway, which would waste a featured slot on something already visible.
	const fillCount = HOME_PER_KIND - HOME_FEATURED_PER_KIND;
	const topCamIps = new Set(hosts.slice(0, fillCount).map((h) => h.ip));
	const topStreamIds = new Set(newestStreams.slice(0, fillCount).map((s) => s.videoId));
	const topFeedIds = new Set(newestFeeds.slice(0, fillCount).map((c) => c.id));
	const liveCamRefs = featured.cams.filter((ip) => camByIp.has(ip) && !topCamIps.has(ip));
	const liveStreamRefs = featured.streams.filter((id) => streamByVideo.has(id) && !topStreamIds.has(id));
	const liveFeedRefs = featured.feeds.filter((id) => feedById.has(id) && !topFeedIds.has(id));
	const homeCams = pickHome(pickRandom(liveCamRefs, HOME_FEATURED_PER_KIND), camByIp, hosts, (h) => h.ip, HOME_PER_KIND);
	const homeStreams = pickHome(pickRandom(liveStreamRefs, HOME_FEATURED_PER_KIND), streamByVideo, newestStreams, (s) => s.videoId, HOME_PER_KIND);
	const homeFeeds = pickHome(pickRandom(liveFeedRefs, HOME_FEATURED_PER_KIND), feedById, newestFeeds, (c) => c.id, HOME_PER_KIND);

	// Homepage "top N" columns. Both feed off aggregations that are also used later (the tags
	// cloud and the fingerprints breakdown), but the homepage needs them before the
	// --index-only early return, so they are computed here from data already in scope.
	// loadTagCounts orders by name, so re-sort a copy by count for the "most-used" list.
	const topTags = [...tagCounts].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, HOME_TOP_N);
	// productBreakdown is reused verbatim for the /fingerprints page below; a make links to its
	// vendor gallery only when that vendor got one this build (vendorsWithGallery, also reused).
	const breakdown = productBreakdown([
		...rows.map((r) => ({ product: r.product, vendor: vendorRefs.byRef.get(r.id) })),
		...feedRows.map((t) => ({ product: t.product, vendor: vendorRefs.byRef.get(t.id) })),
	]);
	const vendorsWithGallery = computeVendorsWithGallery(vendorRefs, hosts, feedCams);
	// Drop the catch-all "Unidentified"/"Other" makes: the front page features what we've
	// actually identified. breakdown is already total-descending, so slice the top N.
	const topMakes = breakdown.filter((g) => g.make !== "Unidentified" && g.make !== "Other").slice(0, HOME_TOP_N);
	const homeExtras = { topTags, topMakes, slugForTag, vendorsWithGallery };
	await writePage(HOME, renderHomeMain(homeCams, homeStreams, homeFeeds, homeExtras, { dev }), TITLE, stats, { dev });

	// --index-only stops here: index.html is fresh, and every other page + image is reused
	// from the last full bake's out/.
	if (indexOnly) {
		console.log(`Wrote out/index.html (--index-only): homepage rebuilt, ${hosts.length} host(s) / ${streams.length} stream(s) / ${feedCams.length} feed(s) reused from the last full bake.`);
		return;
	}

	// ── Hosts (cams) gallery: page 1 also mirrored to the bare /hosts landing ─────────

	const totalPages = Math.max(1, Math.ceil(hosts.length / PAGE_SIZE));
	for (let p = 1; p <= totalPages; p++) {
		const pageHosts = hosts.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
		const mainInner = renderIndexMain(pageHosts, p, totalPages, { dev });
		await writePage(hostsPage(p), mainInner, `hosts | ${TITLE}`, stats, { dev });
		if (p === 1) await writePage(HOSTS, mainInner, `hosts | ${TITLE}`, stats, { dev });
	}

	// ── Per-host pages ─────────────────────────────────────────────────────────────

	for (const host of hosts) {
		const mainInner = renderHostMain(host, { dev, slugForTag });
		await writePage(hostRoute(host.slug), mainInner, `${host.displayName} | ${TITLE}`, stats, { dev });
	}

	// ── Syndication feeds: the newest cameras as RSS + Atom ───────────────────────────
	// `hosts` is already newest-first by observed_at, so the top SYNDICATION_LIMIT are the
	// freshest discoveries. Images are on disk by now (extractImages, above), so the
	// enclosure byte length is a synchronous stat; a host with no screenshot omits it.
	const feedItems = hosts.slice(0, SYNDICATION_LIMIT).map((h) => {
		const len = h.thumbHref ? Bun.file(`${OUT_DIR}${h.thumbHref}`).size : null;
		return hostToFeedItem(h, len);
	});
	await Bun.write(`${OUT_DIR}/rss.xml`, renderRss(feedItems));
	await Bun.write(`${OUT_DIR}/atom.xml`, renderAtom(feedItems));

	// ── Streams gallery (page 1 mirrors /streams) + per-video detail pages ────────────

	const ytTotalPages = Math.max(1, Math.ceil(streams.length / YT_PAGE_SIZE));
	for (let p = 1; p <= ytTotalPages; p++) {
		const pageStreams = streams.slice((p - 1) * YT_PAGE_SIZE, p * YT_PAGE_SIZE);
		const mainInner = renderYtMain(pageStreams, p, ytTotalPages, { dev });
		await writePage(streamsPage(p), mainInner, `streams | ${TITLE}`, stats, { dev });
		if (p === 1) await writePage(STREAMS, mainInner, `streams | ${TITLE}`, stats, { dev });
	}

	for (const s of streams) {
		const siblings = s.channelId ? (streamsByChannel.get(s.channelId) ?? [s]) : [s];
		const mainInner = renderYtDetail(s, siblings, { dev, slugForTag });
		await writePage(streamRoute(s.slug), mainInner, `${s.label} | ${TITLE}`, stats, { dev });
	}

	// ── Feeds gallery (page 1 mirrors /feeds) + per-feed detail pages ─────────────────

	const feedTotalPages = Math.max(1, Math.ceil(feedCams.length / FEED_PAGE_SIZE));
	for (let p = 1; p <= feedTotalPages; p++) {
		const pageCams = feedCams.slice((p - 1) * FEED_PAGE_SIZE, p * FEED_PAGE_SIZE);
		const mainInner = renderFeedMain(pageCams, p, feedTotalPages, { dev });
		await writePage(feedsPage(p), mainInner, `feeds | ${TITLE}`, stats, { dev });
		if (p === 1) await writePage(FEEDS, mainInner, `feeds | ${TITLE}`, stats, { dev });
	}

	for (const cam of feedCams) {
		const mainInner = renderFeedDetail(cam, { dev, slugForTag });
		await writePage(feedRoute(cam.slug), mainInner, `${cam.name} | ${TITLE}`, stats, { dev });
	}

	// ── Tags cloud (linked from the nav; each tag links to its browse page below) ────

	await writePage(TAGS, renderTagsMain(cloudTags, slugForTag), `tags | ${TITLE}`, stats, { dev });

	// ── Tag browse pages: one paginated, blended gallery per tag ─────────────────────
	// Resolve each tagged (kind, ref) against the in-memory view models via the maps
	// built above, keeping each kind's native newest-first order. A tag whose refs are
	// all gone still gets a page (its cloud link must not 404), as the empty state.
	// Page 1 also mirrors the bare /tags/<slug> landing the cloud links to.
	let tagPagesWritten = 0;
	for (const { tag } of cloudTags) {
		const slug = slugForTag(tag);
		const entries = tagIndex.get(tag) ?? autoTagIndex.get(tag) ?? [];
		const camRefs = new Set(entries.filter((e) => e.kind === "cam").map((e) => e.ref));
		const streamRefs = new Set(entries.filter((e) => e.kind === "stream").map((e) => e.ref));
		const feedRefs = new Set(entries.filter((e) => e.kind === "feed").map((e) => e.ref));
		const items: TagItem[] = [
			...hosts.filter((h) => camRefs.has(h.ip)).map((h): TagItem => ({ kind: "cam", host: h })),
			...streams.filter((s) => streamRefs.has(s.videoId)).map((s): TagItem => ({ kind: "stream", stream: s })),
			...feedCams.filter((c) => feedRefs.has(c.id)).map((c): TagItem => ({ kind: "feed", cam: c })),
		];
		const tagTotalPages = Math.max(1, Math.ceil(items.length / TAG_PAGE_SIZE));
		for (let p = 1; p <= tagTotalPages; p++) {
			const pageItems = items.slice((p - 1) * TAG_PAGE_SIZE, p * TAG_PAGE_SIZE);
			const mainInner = renderTagBrowseMain(tag, pageItems, p, tagTotalPages, slug, { dev, slugForTag });
			await writePage(tagPage(slug, p), mainInner, `#${tag} | ${TITLE}`, stats, { dev });
			if (p === 1) await writePage(tagRoute(slug), mainInner, `#${tag} | ${TITLE}`, stats, { dev });
			tagPagesWritten++;
		}
	}

	// ── All-kinds gallery + per-vendor galleries (blended by discovery date) ─────────
	// A card's timestamp is its first_seen (when it entered the site). A host's is the
	// max first_seen across its port rows (its freshest discovery); streams and feeds map
	// 1:1 to a row. Both galleries render blended TagItem cards newest-first.
	const hostFirstSeen = new Map<string, string>();
	for (const r of rows) {
		const cur = hostFirstSeen.get(r.ip_str);
		if (cur === undefined || r.first_seen > cur) hostFirstSeen.set(r.ip_str, r.first_seen);
	}
	const streamFirstSeen = new Map(ytRows.map((r) => [r.id, r.first_seen]));
	const feedFirstSeen = new Map(feedRows.map((r) => [r.id, r.first_seen]));
	type Dated = { ts: string; item: TagItem };
	const datedHosts: Dated[] = hosts.map((h) => ({ ts: hostFirstSeen.get(h.ip) ?? "", item: { kind: "cam", host: h } }));
	const datedStreams: Dated[] = streams.map((s) => ({ ts: streamFirstSeen.get(s.videoId) ?? "", item: { kind: "stream", stream: s } }));
	const datedFeeds: Dated[] = feedCams.map((c) => ({ ts: feedFirstSeen.get(c.id) ?? "", item: { kind: "feed", cam: c } }));

	const galleryItems = [...datedHosts, ...datedStreams, ...datedFeeds].sort(byNewest).map((d) => d.item);
	const galleryTotalPages = Math.max(1, Math.ceil(galleryItems.length / PAGE_SIZE));
	for (let p = 1; p <= galleryTotalPages; p++) {
		const pageItems = galleryItems.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
		const mainInner = renderGalleryMain(pageItems, p, galleryTotalPages, { dev });
		await writePage(galleryPage(p), mainInner, `gallery | ${TITLE}`, stats, { dev });
		if (p === 1) await writePage(GALLERY, mainInner, `gallery | ${TITLE}`, stats, { dev });
	}

	// Per-vendor galleries: the cam hosts + feeds whose fingerprint vendor matches, blended by
	// discovery date. `vendorsWithGallery` (computed above, before the homepage) is the set of
	// vendors with at least one visible card; iterating it skips vendors that would yield an
	// empty page, so a "filter" link never points at nothing.
	let vendorPagesWritten = 0;
	for (const vendor of vendorsWithGallery) {
		const refs = vendorRefs.byVendor.get(vendor);
		if (!refs) continue;
		const items = [
			...datedHosts.filter((d) => d.item.kind === "cam" && refs.hosts.has(d.item.host.ip)),
			...datedFeeds.filter((d) => d.item.kind === "feed" && refs.feeds.has(d.item.cam.id)),
		]
			.sort(byNewest)
			.map((d) => d.item);
		const vTotalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
		for (let p = 1; p <= vTotalPages; p++) {
			const pageItems = items.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
			const mainInner = renderVendorMain(vendor, pageItems, p, vTotalPages, { dev });
			await writePage(vendorPage(vendor, p), mainInner, `${vendor} | ${TITLE}`, stats, { dev });
			if (p === 1) await writePage(vendorRoute(vendor), mainInner, `${vendor} | ${TITLE}`, stats, { dev });
			vendorPagesWritten++;
		}
	}

	// ── Fingerprints breakdown: make/model/count, each make linking its vendor gallery ─
	// `breakdown` and `vendorsWithGallery` were both computed above for the homepage columns
	// (breakdown from cams.product across both device sources, tagged with each row's vendor);
	// reuse them here so the make → model → count table and its "filter" links stay in sync.
	await writePage(FINGERPRINTS, renderFingerprintsMain(breakdown, vendorsWithGallery), `fingerprints | ${TITLE}`, stats, { dev });

	// ── Tips: a single static standalone page (content baked from tips.md) ────────────
	await writePage(TIPS, renderTipsMain(), `tips | ${TITLE}`, stats, { dev });

	// ── Import (DEV-ONLY): add cams from the browser instead of the CLI ───────────────
	// Baked only under `bun dev`; a production bake emits none of it, and the nav button
	// is gated the same way in renderShell. The per-type form fragments are snippet-only
	// (the type buttons hx-get them into #import-form; nothing navigates to them as a
	// page), so they skip writePage and go straight to their co-located snippet path.
	if (dev) {
		await writePage(IMPORT, renderImportMain(), `import | ${TITLE}`, stats, { dev });
		for (const t of ["shodan", "youtube", "mjpeg"] as const) {
			await Bun.write(`${OUT_DIR}/${importFormSnippetDisk(t)}`, `${renderImportForm(t)}\n`);
		}
	}

	// ── World map: a dot per geolocated camera across all three sources ──────────────
	// Shodan hosts carry coarse geo-IP coords, feed cams precise ones, and YouTube
	// streams only whatever we hand-assigned inline (see loadYtGeo); a source lacking a
	// coord is simply skipped. Each dot links to that cam's existing detail page.
	const loc = (...parts: (string | null)[]): string =>
		parts.filter((v): v is string => !!v && v.trim() !== "").join(", ");
	const mapPoints: MapPoint[] = [];
	for (const h of hosts) {
		if (h.latitude == null || h.longitude == null) continue;
		const { x, y } = project(h.latitude, h.longitude);
		const route = hostRoute(h.slug);
		mapPoints.push({ x, y, href: urlOf(route), snip: snipUrlOf(route), title: loc(h.city, h.country_name) || h.displayName });
	}
	for (const c of feedCams) {
		if (c.lat == null || c.lng == null) continue;
		const { x, y } = project(c.lat, c.lng);
		const route = feedRoute(c.slug);
		mapPoints.push({ x, y, href: urlOf(route), snip: snipUrlOf(route), title: loc(c.city, c.country) || c.name });
	}
	for (const s of streams) {
		const g = ytGeo.get(s.videoId);
		if (!g) continue;
		const { x, y } = project(g.lat, g.lng);
		const route = streamRoute(s.slug);
		mapPoints.push({ x, y, href: urlOf(route), snip: snipUrlOf(route), title: s.label });
	}
	await writePage(MAP, renderMapMain(mapPoints, mapPoints.length), `map | ${TITLE}`, stats, { dev });

	const images = written.size;
	console.log(
		`Wrote ${OUT_DIR}/: homepage + ${hosts.length} host(s) across ${totalPages} hosts page(s), ` +
			`${streams.length} stream(s) across ${ytTotalPages} streams page(s), ` +
			`${feedCams.length} feed(s) across ${feedTotalPages} feeds page(s), ` +
			`gallery (${galleryItems.length} card(s) across ${galleryTotalPages} page(s)), ` +
			`${vendorsWithGallery.size} vendor gallery/-ies across ${vendorPagesWritten} page(s), ` +
			`map (${mapPoints.length.toLocaleString()} dot(s)), tags cloud + ${tagPagesWritten} browse page(s) across ${cloudTags.length} tag(s), ` +
			`fingerprints, tips page, ${images} image(s).${dev ? " (dev build)" : " Run `bun run serve`."}`,
	);
}

// Direct run (`bun run bake` / `bun run src/build.ts`) bakes the production site.
if (import.meta.main) await build();
