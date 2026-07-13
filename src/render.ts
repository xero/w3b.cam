// Pure rendering: DB rows -> HTML strings. No IO here (build.ts does the writing
// and image extraction). Every banner-derived string is attacker-controlled, so it
// is HTML-escaped before interpolation, exactly as the original single-page build did.

import { displayParts, escapeHtml, pickDisplayName } from "./util.ts";
import type { FeedKind, ProductGroup, StoredRow, StoredFeedRow, StoredYtRow } from "./types.ts";
import { TIPS_HTML } from "./tips.ts";
import { WORLD_PATHS } from "./worldmap.ts";
import {
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
	hostSlug,
	hostsPage,
	importFormSnippetUrl,
	snipUrlOf,
	streamRoute,
	streamsPage,
	tagPage,
	tagRoute,
	urlOf,
	vendorPage,
	vendorRoute,
	ytSlug,
} from "./urls.ts";

export const TITLE = "w3b.cam";
export const THEME_COLOR = "#667eea";

/** Map viewBox size. The world outlines in worldmap.ts are pre-projected into this space. */
export const MAP_W = 1000;
export const MAP_H = 500;

/** Equirectangular projection of a coordinate into the map viewBox (must match worldmap.ts). */
export function project(lat: number, lng: number): { x: number; y: number } {
	return { x: ((lng + 180) / 360) * MAP_W, y: ((90 - lat) / 180) * MAP_H };
}

/** Tab of depth n (web-style: tabs, never spaces). */
export const T = (n: number): string => "\t".repeat(n);

/** Prefix every non-empty line of a block with `level` tabs. */
export function indentBlock(text: string, level: number): string {
	const pad = T(level);
	return text
		.split("\n")
		.map((l) => (l.length ? pad + l : l))
		.join("\n");
}

export function safeParseArray(json: string): string[] {
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// The base64 image is inert once decoded to a file, but validate the MIME against an
// allowlist so a hostile `mime` string can't pick an unexpected extension.
const SAFE_MIME = /^image\/(jpeg|png|gif|webp|bmp)$/;
const MIME_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

/** File extension for a screenshot, allowlisted; defaults to jpg. */
export function extFromMime(mime: string): string {
	return SAFE_MIME.test(mime) ? (MIME_EXT[mime] ?? "jpg") : "jpg";
}

// The page/snippet URL + slug helpers now live in src/urls.ts (imported above): the
// route model (urlOf/snipUrlOf), the per-section route builders, and the slug functions.

/**
 * Live-view URL for a host:port (external link, opened in a new tab). IPv6 literals
 * are bracketed; scheme-default ports are dropped for clean URLs. 443 -> https, 554
 * -> rtsp, 80 -> bare http, everything else -> http on the explicit port.
 */
export function liveUrl(ip: string, port: number): string {
	const host = ip.includes(":") ? `[${ip}]` : ip;
	switch (port) {
		case 443:
			return `https://${host}/`;
		case 554:
			return `rtsp://${host}/`;
		case 80:
			return `http://${host}/`;
		default:
			return `http://${host}:${port}/`;
	}
}

// ── Grouped model ────────────────────────────────────────────────────────────

export interface Shot {
	port: number;
	product: string | null;
	timestamp: string | null;
	imgHref: string;
	imgAlt: string;
	liveHref: string;
}

export interface Host {
	ip: string;
	slug: string;
	displayName: string;
	count: number;
	shots: Shot[];
	thumbHref: string;
	thumbAlt: string;
	// shared metadata, coalesced from the most-recent-timestamp row
	country_name: string | null;
	city: string | null;
	region_code: string | null;
	latitude: number | null;
	longitude: number | null;
	org: string | null;
	isp: string | null;
	asn: string | null;
	product: string | null;
	hostnames: string[];
	domains: string[];
	labels: string[];
	httpTitle: string | null;
	// Free-form tags applied per-IP (the `tags` table, kind='cam'), shared across all of a host's ports.
	tags: string[];
}

function jsonPath(raw: string, get: (o: Record<string, unknown>) => unknown): unknown {
	try {
		const o: unknown = JSON.parse(raw);
		return o && typeof o === "object" ? get(o as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractHttpTitle(raw: string): string | null {
	const http = jsonPath(raw, (o) => o.http);
	if (http && typeof http === "object" && "title" in http) {
		const t = (http as { title?: unknown }).title;
		return typeof t === "string" && t.trim() ? t : null;
	}
	return null;
}

function extractLabels(raw: string): string[] {
	const ss = jsonPath(raw, (o) => o.screenshot);
	if (ss && typeof ss === "object" && "labels" in ss) {
		const l = (ss as { labels?: unknown }).labels;
		return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
	}
	return [];
}

/**
 * Which of two rows should represent a host on its card. A pinned row
 * (`preferred = 1`, set via `bun run reorder`) wins outright; otherwise the most
 * recent by timestamp wins (ISO strings sort lexically), and a tie keeps
 * `current`, the earlier row in the (…, port) query order, so ties fall to the
 * lowest port. With nothing pinned this is identical to the old newest-wins rule.
 */
function isBetterRep(candidate: StoredRow, current: StoredRow): boolean {
	const cp = candidate.preferred ? 1 : 0;
	const rp = current.preferred ? 1 : 0;
	if (cp !== rp) return cp > rp;
	return (candidate.observed_at ?? "") > (current.observed_at ?? "");
}

/**
 * Collapse rows sharing an IP into host entries, ordered newest-first by each
 * host's representative-row timestamp. The representative row supplies the card
 * thumbnail and shared metadata: it is the row pinned via `reorder`
 * (`preferred = 1`), else the most-recent by timestamp; a pinned host ranks
 * in the gallery by its pinned shot's timestamp. Rows arrive ordered by
 * (country_name, ip_str, port), so a host's ports stay adjacent, shots keep
 * their port order, and hosts sharing a timestamp fall back to that stable
 * country-grouped order. `imgHref` maps a row to the URL of its already-extracted
 * screenshot file. `tagsByIp` supplies per-IP tags (see loadTags); an IP absent
 * from the map has no tags.
 */
export function groupByIp(
	rows: StoredRow[],
	imgHref: (row: StoredRow) => string,
	tagsByIp: Map<string, string[]> = new Map(),
): Host[] {
	const groups = new Map<string, StoredRow[]>();
	for (const r of rows) {
		const g = groups.get(r.ip_str);
		if (g) g.push(r);
		else groups.set(r.ip_str, [r]);
	}

	const usedSlugs = new Set<string>();
	// Pair each host with its representative (most-recent) timestamp so the whole
	// set can be ordered newest-first once every group is built.
	const built: { host: Host; ts: string }[] = [];
	for (const [ip, group] of groups) {
		// Representative row = the pinned row if any, else most recent (see isBetterRep).
		let rep = group[0];
		if (!rep) continue; // unreachable: a group always has >= 1 row
		for (const r of group) {
			if (isBetterRep(r, rep)) rep = r;
		}

		let slug = hostSlug(ip) || "host";
		if (usedSlugs.has(slug)) {
			let n = 2;
			while (usedSlugs.has(`${slug}-${n}`)) n++;
			slug = `${slug}-${n}`;
		}
		usedSlugs.add(slug);

		const shots: Shot[] = group.map((r) => ({
			port: r.port,
			product: r.product,
			timestamp: r.observed_at,
			imgHref: imgHref(r),
			imgAlt: `Screenshot from ${r.ip_str}:${r.port}`,
			liveHref: liveUrl(r.ip_str, r.port),
		}));

		const host: Host = {
			ip,
			slug,
			displayName: pickDisplayName(
				safeParseArray(rep.hostnames),
				safeParseArray(rep.domains),
				ip,
				shots.map((s) => s.port),
			),
			count: shots.length,
			shots,
			thumbHref: imgHref(rep),
			thumbAlt: `Screenshot from ${ip}`,
			country_name: rep.country_name,
			city: rep.city,
			region_code: rep.region_code,
			latitude: rep.lat,
			longitude: rep.lng,
			org: rep.org,
			isp: rep.isp,
			asn: rep.asn,
			product: rep.product,
			hostnames: safeParseArray(rep.hostnames),
			domains: safeParseArray(rep.domains),
			labels: extractLabels(rep.raw_json),
			httpTitle: extractHttpTitle(rep.raw_json),
			tags: tagsByIp.get(ip) ?? [],
		};
		built.push({ host, ts: rep.observed_at ?? "" });
	}

	// Newest host first. ISO timestamps sort lexically; a missing timestamp ("")
	// sorts last. Array.sort is stable, so hosts sharing a timestamp keep the
	// country-grouped insertion order established above.
	built.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	return built.map((b) => b.host);
}

// ── Pagination ───────────────────────────────────────────────────────────────

/** Windowed page set: fixed width of 2·span+5 slots, with "…" filling gaps. */
export function pageWindow(cur: number, total: number, span = 2): (number | "…")[] {
	const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
	if (total <= 2 * span + 5) return range(1, total);
	if (cur <= span + 2) return [...range(1, 2 * span + 3), "…", total];
	if (cur >= total - span - 1) return [1, "…", ...range(total - 2 * span - 2, total)];
	return [1, "…", ...range(cur - span, cur + span), "…", total];
}

/**
 * The three stacked layers of a `.btn` (shadow / edge / labelled front face).
 * `label` is always trusted here, whether page numbers, HTML entities (`&laquo;`),
 * or a literal, so it is interpolated as-is, matching the rest of the pager markup.
 */
function btnLayers(label: string): string {
	return [
		`${T(1)}<span class="shadow"></span>`,
		`${T(1)}<span class="edge"></span>`,
		`${T(1)}<span class="front">${label}</span>`,
	].join("\n");
}

/** Navigable pager entry: a real link (works without JS), styled as a `.btn`. */
function pageLink(href: string, snip: string, label: string, cls = ""): string {
	return [
		`<a class="btn${cls ? " " + cls : ""}" href="${href}" hx-get="${snip}" hx-push-url="${href}">`,
		btnLayers(label),
		`</a>`,
	].join("\n");
}

/** Inactive «/‹/›/» arrow: a disabled button (greyed `.btn` face), not a link. */
function pageDisabled(label: string): string {
	return [`<button class="btn" disabled>`, btnLayers(label), `</button>`].join("\n");
}

/** Current page: a disabled button marked aria-current; keeps the accent `.btn` face. */
function pageCurrent(p: number): string {
	return [`<button class="btn" aria-current="page" disabled>`, btnLayers(String(p)), `</button>`].join("\n");
}

/**
 * Numbered pager (`« ‹ 1 … 4 [5] 6 … 77 › »`), parameterized by the URL builders
 * so the index and the streams gallery share one implementation. Empty when
 * there is only one page.
 */
function renderPagerWith(
	cur: number,
	total: number,
	urlFor: (p: number) => string,
	snipFor: (p: number) => string,
): string {
	if (total <= 1) return "";
	const parts: string[] = [];
	const first = cur > 1;
	const last = cur < total;
	const link = (p: number, label: string, cls?: string) => pageLink(urlFor(p), snipFor(p), label, cls);

	parts.push(first ? link(1, "&laquo;") : pageDisabled("&laquo;"));
	parts.push(first ? link(cur - 1, "&lsaquo;") : pageDisabled("&lsaquo;"));
	// The boundary shortcuts, leading `1 …` / trailing `… total`, carry `.pager-ends`
	// so a narrow-width media query can hide them, leaving the local window + arrows.
	// `pageWindow` only ever emits "…" beside a boundary sentinel, so every gap is an
	// end, and a page number is an end only when it sits at the window edge next to a gap.
	const win = pageWindow(cur, total);
	win.forEach((p, i) => {
		if (p === "…") parts.push(`<span class="gap pager-ends">&hellip;</span>`);
		else if (p === cur) parts.push(pageCurrent(p));
		else {
			const isEnd =
				(i === 0 && win[1] === "…") || (i === win.length - 1 && win[win.length - 2] === "…");
			parts.push(link(p, String(p), isEnd ? "pager-ends" : undefined));
		}
	});
	parts.push(last ? link(cur + 1, "&rsaquo;") : pageDisabled("&rsaquo;"));
	parts.push(last ? link(total, "&raquo;") : pageDisabled("&raquo;"));

	const items = parts.map((p) => indentBlock(p, 1)).join("\n");
	return [`<nav class="pager" aria-label="Pagination">`, items, `</nav>`].join("\n");
}

/** Build a pager whose links are the numbered pages of one section (page 1 included). */
const sectionPager = (route: (p: number) => string) => (cur: number, total: number): string =>
	renderPagerWith(cur, total, (p) => urlOf(route(p)), (p) => snipUrlOf(route(p)));

/** Numbered pager for the hosts (cams) gallery. */
export const renderPager = sectionPager(hostsPage);

/** Numbered pager for the all-kinds gallery. */
export const renderGalleryPager = sectionPager(galleryPage);

/** Numbered pager for the YouTube streams gallery. */
export const renderStreamsPager = sectionPager(streamsPage);

/** Numbered pager for the feeds gallery. */
export const renderFeedPager = sectionPager(feedsPage);

/** Numbered pager for a per-vendor fingerprint gallery. */
export const renderVendorPager = (cur: number, total: number, vendor: string): string =>
	sectionPager((p) => vendorPage(vendor, p))(cur, total);

// ── Index cards ──────────────────────────────────────────────────────────────

/**
 * Rendering toggles, threaded as a trailing optional param (default `{}`) so every
 * production call is unchanged. `dev` bakes data-* hooks onto cards/shots/details and
 * injects the dev client. `slugForTag` maps a tag to its browse-page slug so the
 * detail-page "Tags" row can link each tag; absent (production galleries never need
 * it) means tags render as plain text.
 */
export interface RenderOpts {
	dev?: boolean;
	slugForTag?: (tag: string) => string;
}

/**
 * The `ip:ports` half of a host title, tinted. The `:` separator keeps the default
 * text colour; the ip and ports are coloured. Always present (ports may be empty).
 * Every segment is escaped since these values are attacker-controlled. Shared by
 * the gallery cards and the per-host page heading so both tint identically.
 */
function renderHostPort(host: Host): string {
	const { host: ip, ports } = displayParts(
		host.hostnames,
		host.domains,
		host.ip,
		host.shots.map((s) => s.port),
	);
	return (
		`<span class="dn-ip">${escapeHtml(ip)}</span>` +
		(ports.length ? `:<span class="dn-ports">${escapeHtml(ports.join(","))}</span>` : "")
	);
}

/**
 * The `(hostname)` half of a host title: first real domain/hostname wrapped in
 * parens, tinted; `""` when the host has none. The parens keep the default text
 * colour to match the untinted separators; only the name is coloured.
 */
function renderHostName(host: Host): string {
	const { name } = displayParts(
		host.hostnames,
		host.domains,
		host.ip,
		host.shots.map((s) => s.port),
	);
	return name ? `(<span class="dn-name">${escapeHtml(name)}</span>)` : "";
}

/**
 * One host card for the index grid. The screenshot is a `<figure>` with the image
 * as its CSS background (inline `style`, since the URL is per-card and dynamic), with
 * the shot-count badge overlaid in its corner. The title is a fixed two-line shape
 * (`ip:ports` then `(hostname)`) so every card occupies the same height even when a
 * host has no hostname; location follows on a third line.
 */
export function renderHostCard(host: Host, opts: RenderOpts = {}): string {
	const badge =
		host.count > 1
			? `\n${T(2)}<span class="badge">${host.count} angles</span>`
			: "";
	const loc = [host.city, host.country_name]
		.filter((v): v is string => !!v && v.trim() !== "")
		.map(escapeHtml)
		.join(", ");
	const locLine = loc ? `\n${T(1)}<p class="loc">${loc}</p>` : "";
	// Dev hook: blacklist/tag act on the IP (ref); reorder is per-screenshot, not per-card.
	const devAttrs = opts.dev ? ` data-kind="cam" data-ref="${escapeHtml(host.ip)}"` : "";

	const route = hostRoute(host.slug);
	return [
		`<a class="card" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}"${devAttrs}>`,
		`${T(1)}<figure role="img" aria-label="${escapeHtml(host.thumbAlt)}" style="background-image:url('${escapeHtml(host.thumbHref)}')">${badge}`,
		`${T(1)}</figure>`,
		`${T(1)}<h2>`,
		`${T(2)}<span class="dn-line">${renderHostPort(host)}</span>`,
		`${T(2)}<span class="dn-sub">${renderHostName(host)}</span>`,
		`${T(1)}</h2>${locLine}`,
		`</a>`,
	].join("\n");
}

/** Inner-<main> content for an index page: the card grid plus the pager. */
export function renderIndexMain(hosts: Host[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (hosts.length === 0) {
		return `<p class="empty">No cameras stored yet. Run <code>bun run scrape</code> first.</p>`;
	}
	const cards = hosts.map((h) => indentBlock(renderHostCard(h, opts), 1)).join("\n");
	const pager = renderPager(page, totalPages);
	return [
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
	].join("\n");
}

// ── Homepage ─────────────────────────────────────────────────────────────────

/**
 * The two "top N" lists shown below the card sections on the homepage: the most-used
 * tags beside the most-common camera makes. Both come pre-sliced (top 10, descending)
 * from build.ts; `slugForTag` maps a tag to its browse-page slug, and `vendorsWithGallery`
 * gates which makes link to a `/fingerprints/<vendor>` gallery (the rest are plain text).
 */
export interface HomeExtras {
	topTags: { tag: string; count: number }[];
	topMakes: ProductGroup[];
	slugForTag: (tag: string) => string;
	vendorsWithGallery: Set<string>;
}

/**
 * One "top N" column: an underlined heading, a ranked list of `name (count)` rows, then a
 * "more" link to the full listing. `rows` are pre-rendered <li> strings so tags and makes
 * can each build their own link/plain-text markup. Returns "" when there are no rows, so an
 * empty column is dropped rather than showing a bare header.
 */
function renderHomeColumn(title: string, rows: string[], moreHref: string, moreSnip: string, moreLabel: string): string {
	if (rows.length === 0) return "";
	return [
		`<div class="home-col">`,
		`${T(1)}<h2 class="section-title">${escapeHtml(title)}</h2>`,
		`${T(1)}<ol class="top-list">`,
		indentBlock(rows.join("\n"), 2),
		`${T(1)}</ol>`,
		`${T(1)}<a class="more" href="${moreHref}" hx-get="${moreSnip}" hx-push-url="${moreHref}">${escapeHtml(moreLabel)} &rarr;</a>`,
		`</div>`,
	].join("\n");
}

/** A `name (count)` row where the name links somewhere. */
function topRow(href: string, snip: string, name: string, count: number): string {
	return `<li><a href="${href}" hx-get="${snip}" hx-push-url="${href}">${escapeHtml(name)}</a> <span class="cnt">${count.toLocaleString()}</span></li>`;
}

/**
 * Inner-<main> for the homepage (index.html): a curated landing page with cams, streams,
 * and feeds sections (each up to four cards: the featured pins first, then the newest —
 * build.ts assembles the ordering), followed by two "top N" columns (most-used tags beside
 * most-common camera makes). Reuses the gallery cards verbatim; a "more" link jumps to the
 * full paginated gallery. An empty section is dropped, and if everything is empty the
 * galleries' "nothing yet" note shows.
 */
export function renderHomeMain(cams: Host[], streams: YtStream[], feeds: FeedCam[], extras: HomeExtras, opts: RenderOpts = {}): string {
	const section = (title: string, cards: string, moreHref: string, moreSnip: string, moreLabel: string): string =>
		[
			`<section class="home">`,
			`${T(1)}<h2 class="section-title">${escapeHtml(title)}</h2>`,
			`${T(1)}<div class="gallery">`,
			indentBlock(cards, 1),
			`${T(1)}</div>`,
			`${T(1)}<a class="more" href="${moreHref}" hx-get="${moreSnip}" hx-push-url="${moreHref}">${escapeHtml(moreLabel)} &rarr;</a>`,
			`</section>`,
		].join("\n");

	const parts: string[] = [];
	if (cams.length) {
		const cards = cams.map((h) => indentBlock(renderHostCard(h, opts), 1)).join("\n");
		parts.push(section("cams", cards, urlOf(HOSTS), snipUrlOf(HOSTS), "all cams"));
	}
	if (streams.length) {
		const cards = streams.map((s) => indentBlock(renderYtCard(s, opts), 1)).join("\n");
		parts.push(section("streams", cards, urlOf(STREAMS), snipUrlOf(STREAMS), "all streams"));
	}
	if (feeds.length) {
		const cards = feeds.map((c) => indentBlock(renderFeedCard(c, opts), 1)).join("\n");
		parts.push(section("feeds", cards, urlOf(FEEDS), snipUrlOf(FEEDS), "all feeds"));
	}

	// Two "top N" columns below the card sections. Tags always link to their browse page;
	// a make links to its vendor gallery only when that vendor actually got one this build,
	// otherwise it renders as plain text (still escaped — makes echo banner text).
	const { topTags, topMakes, slugForTag, vendorsWithGallery } = extras;
	const tagRows = topTags.map((t) => {
		const route = tagRoute(slugForTag(t.tag));
		return topRow(urlOf(route), snipUrlOf(route), t.tag, t.count);
	});
	const makeRows = topMakes.map((g) => {
		if (g.vendor && vendorsWithGallery.has(g.vendor)) {
			const route = vendorRoute(g.vendor);
			return topRow(urlOf(route), snipUrlOf(route), g.make, g.total);
		}
		return `<li><span>${escapeHtml(g.make)}</span> <span class="cnt">${g.total.toLocaleString()}</span></li>`;
	});
	const tagsCol = renderHomeColumn("top tags", tagRows, urlOf(TAGS), snipUrlOf(TAGS), "all tags");
	const makesCol = renderHomeColumn("top makes", makeRows, urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS), "all fingerprints");
	const cols = [tagsCol, makesCol].filter((c) => c !== "");
	if (cols.length) {
		parts.push([`<section class="home-cols">`, indentBlock(cols.join("\n"), 1), `</section>`].join("\n"));
	}

	if (parts.length === 0) {
		return `<p class="empty">Nothing to feature yet. Run <code>bun scrape</code>, <code>bun import --youtube</code>, <code>bun import --mjpeg</code>, <code>bun import --hls</code>, or <code>bun run osiris</code> first.</p>`;
	}
	return parts.join("\n");
}

// ── Host page ────────────────────────────────────────────────────────────────

function metaRow(label: string, valueHtml: string): string {
	return [
		`<tr>`,
		`${T(1)}<th scope="row">${escapeHtml(label)}</th>`,
		`${T(1)}<td>${valueHtml}</td>`,
		`</tr>`,
	].join("\n");
}

/**
 * The comma-joined value for a "Tags" meta row. With `slugForTag` each tag is an
 * anchor to its browse page (real href + hx-get so it works with no JS); without it
 * (a context that has no slug map) tags fall back to plain escaped text. Names are
 * attacker-controlled, so escaped either way.
 */
function renderTagLinks(tags: string[], slugForTag?: (tag: string) => string): string {
	if (!slugForTag) return escapeHtml(tags.join(", "));
	return tags
		.map((t) => {
			const route = tagRoute(slugForTag(t));
			return `<a href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}">${escapeHtml(t)}</a>`;
		})
		.join(", ");
}

function shotFigure(shot: Shot, ip: string, opts: RenderOpts = {}): string {
	const caption = [
		`Port ${escapeHtml(shot.port)}`,
		shot.product && shot.product.trim() ? escapeHtml(shot.product) : "",
		shot.timestamp ? `<time datetime="${escapeHtml(shot.timestamp)}">${escapeHtml(shot.timestamp)}</time>` : "",
	]
		.filter((s) => s !== "")
		.join(" &middot; ");
	// Dev hook: reorder acts on this exact (ip, port); blacklist/tag act on the IP (ref).
	const devAttrs = opts.dev ? ` data-kind="cam" data-ref="${escapeHtml(ip)}" data-port="${escapeHtml(shot.port)}"` : "";
	return [
		`${T(1)}<figure class="shot"${devAttrs}>`,
		`${T(2)}<img src="${escapeHtml(shot.imgHref)}" alt="${escapeHtml(shot.imgAlt)}" loading="lazy" />`,
		`${T(2)}<figcaption>${caption}</figcaption>`,
		`${T(2)}<a class="btn" href="${escapeHtml(shot.liveHref)}" target="_blank" rel="noopener noreferrer">`,
		indentBlock(btnLayers("View live"), 2),
		`${T(2)}</a>`,
		`${T(1)}</figure>`,
	].join("\n");
}

/** Inner-<main> content for a host page: screenshots up top, one shared metadata table. */
export function renderHostMain(host: Host, opts: RenderOpts = {}): string {
	const shots = host.shots.map((s) => shotFigure(s, host.ip, opts)).join("\n");

	const rows: string[] = [];
	const push = (label: string, value: string | null | undefined): void => {
		if (value && String(value).trim() !== "") rows.push(metaRow(label, escapeHtml(value)));
	};
	push("Title", host.httpTitle);
	push("Fingerprint", host.product);
	if (host.hostnames.length) push("Hostnames", host.hostnames.join(", "));
	if (host.domains.length) push("Domains", host.domains.join(", "));
	push("Country", host.country_name);
	push("City", host.city);
	push("Region", host.region_code);
	push("Organization", host.org);
	push("ISP", host.isp);
	push("ASN", host.asn);
	rows.push(metaRow("Ports", escapeHtml(host.shots.map((s) => s.port).join(", "))));
	if (host.tags.length) rows.push(metaRow("Tags", renderTagLinks(host.tags, opts.slugForTag)));

	const nameHtml = renderHostName(host);
	const heading = nameHtml ? `${renderHostPort(host)} ${nameHtml}` : renderHostPort(host);

	return [
		`<article class="host">`,
		`${T(1)}<h2>${heading}</h2>`,
		`${T(1)}<div class="shots">`,
		indentBlock(shots, 1),
		`${T(1)}</div>`,
		`${T(1)}<table class="meta">`,
		`${T(2)}<tbody>`,
		indentBlock(rows.join("\n"), 3),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		`${T(1)}<a class="back" href="${urlOf(HOSTS)}" hx-get="${snipUrlOf(HOSTS)}" hx-push-url="${urlOf(HOSTS)}">&larr; Back to hosts</a>`,
		`</article>`,
	].join("\n");
}

// ── YouTube streams ────────────────────────────────────────────────────────────
// A second source with its own flat gallery: every stream is its own card (no
// grouping like the Shodan hosts). Channel grouping surfaces only on a detail
// page, which links sibling streams sharing a channel_id.

export interface YtStream {
	videoId: string;
	slug: string;
	/** Canonical watch URL (external link). */
	url: string;
	/** Display title: the curated youtube.md label, else the API title, else the id. */
	label: string;
	channelId: string | null;
	channelTitle: string | null;
	/** "live" | "upcoming" | "none" | null. */
	liveContent: string | null;
	publishedAt: string | null;
	scheduledStart: string | null;
	actualStart: string | null;
	/** URL of the already-extracted thumbnail file, or "" when none was stored. */
	thumbHref: string;
	thumbAlt: string;
	/** Free-form tags applied to this stream (see the unified `tags` table), sorted. */
	tags: string[];
}

/** Map a stored youtube row (plus its extracted image URL and tags) into a view model. */
export function toYtStream(row: StoredYtRow, thumbHref: string, tags: string[] = []): YtStream {
	const label = (row.label && row.label.trim()) || (row.title && row.title.trim()) || row.id;
	return {
		videoId: row.id,
		slug: ytSlug(row.id),
		url: row.live_url,
		label,
		channelId: row.channel_id,
		channelTitle: row.channel_title,
		liveContent: row.live_content,
		publishedAt: row.published_at,
		scheduledStart: row.scheduled_start,
		actualStart: row.actual_start,
		thumbHref,
		thumbAlt: `Thumbnail for ${label}`,
		tags,
	};
}

/** Human-readable live status for the detail metadata table. */
function liveStatusText(liveContent: string | null): string | null {
	switch (liveContent) {
		case "live":
			return "Live now";
		case "upcoming":
			return "Upcoming";
		case "none":
			return "Offline";
		default:
			return null;
	}
}

/**
 * One stream card for the streams gallery. Same shape as a host card (thumbnail
 * figure with a corner badge, a one-line title, a subtitle line) so both
 * galleries render identically; here the title is the stream label and the
 * subtitle is the channel.
 */
export function renderYtCard(stream: YtStream, opts: RenderOpts = {}): string {
	const channel = stream.channelTitle
		? `\n${T(1)}<p class="loc">${escapeHtml(stream.channelTitle)}</p>`
		: "";
	const devAttrs = opts.dev ? ` data-kind="stream" data-ref="${escapeHtml(stream.videoId)}"` : "";
	const route = streamRoute(stream.slug);
	return [
		`<a class="card" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}"${devAttrs}>`,
		`${T(1)}<figure role="img" aria-label="${escapeHtml(stream.thumbAlt)}" style="background-image:url('${escapeHtml(stream.thumbHref)}')">`,
		`${T(1)}</figure>`,
		`${T(1)}<h2>`,
		`${T(2)}<span class="dn-line dn-name">${escapeHtml(stream.label)}</span>`,
		`${T(1)}</h2>${channel}`,
		`</a>`,
	].join("\n");
}

/** Inner-<main> content for a streams gallery page: the card grid plus the pager. */
export function renderYtMain(streams: YtStream[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (streams.length === 0) {
		return `<p class="empty">No streams stored yet. Run <code>bun run youtube</code> first.</p>`;
	}
	const cards = streams.map((s) => indentBlock(renderYtCard(s, opts), 1)).join("\n");
	const pager = renderStreamsPager(page, totalPages);
	return [
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
	].join("\n");
}

/** "More from {channel}" section: sibling streams on the same channel, as cards. Empty when there are none. */
function renderSiblings(stream: YtStream, siblings: YtStream[], opts: RenderOpts = {}): string {
	const others = siblings.filter((s) => s.videoId !== stream.videoId);
	if (others.length === 0) return "";
	const heading = stream.channelTitle ? `More from ${stream.channelTitle}` : "More from this channel";
	const cards = others.map((s) => indentBlock(renderYtCard(s, opts), 1)).join("\n");
	return [
		`<section class="siblings">`,
		`${T(1)}<h3>${escapeHtml(heading)}</h3>`,
		`${T(1)}<div class="gallery">`,
		indentBlock(cards, 1),
		`${T(1)}</div>`,
		`</section>`,
	].join("\n");
}

/**
 * Inner-<main> content for a stream's detail page: the thumbnail with a "Watch
 * on YouTube" button, a lean metadata table, then any sibling streams from the
 * same channel. `siblings` is the full set for this channel (this stream is
 * filtered out inside renderSiblings).
 */
export function renderYtDetail(stream: YtStream, siblings: YtStream[], opts: RenderOpts = {}): string {
	// Dev hook on the figure (a `.shot`, like host pages) so right-click tags this stream.
	const devAttrs = opts.dev ? ` data-kind="stream" data-ref="${escapeHtml(stream.videoId)}"` : "";
	const figure = [
		`${T(1)}<figure class="shot"${devAttrs}>`,
		ytFacade(stream),
		`${T(2)}<a class="btn" href="${escapeHtml(stream.url)}" target="_blank" rel="noopener noreferrer">`,
		indentBlock(btnLayers("Watch on YouTube"), 2),
		`${T(2)}</a>`,
		`${T(1)}</figure>`,
	].join("\n");

	const rows: string[] = [];
	const push = (label: string, value: string | null | undefined): void => {
		if (value && String(value).trim() !== "") rows.push(metaRow(label, escapeHtml(value)));
	};
	push("Channel", stream.channelTitle);
	push("Status", liveStatusText(stream.liveContent));
	push("Published", stream.publishedAt);
	push("Scheduled", stream.scheduledStart);
	push("Started", stream.actualStart);
	if (stream.tags.length) rows.push(metaRow("Tags", renderTagLinks(stream.tags, opts.slugForTag)));

	const siblingSection = renderSiblings(stream, siblings, opts);

	return [
		`<article class="host">`,
		`${T(1)}<h2>${escapeHtml(stream.label)}</h2>`,
		`${T(1)}<div class="shots">`,
		indentBlock(figure, 1),
		`${T(1)}</div>`,
		`${T(1)}<table class="meta">`,
		`${T(2)}<tbody>`,
		indentBlock(rows.join("\n"), 3),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		...(siblingSection ? [indentBlock(siblingSection, 1)] : []),
		`${T(1)}<a class="back" href="${urlOf(STREAMS)}" hx-get="${snipUrlOf(STREAMS)}" hx-push-url="${urlOf(STREAMS)}">&larr; Back to streams</a>`,
		`</article>`,
	].join("\n");
}

/**
 * Click-to-load YouTube facade for a stream detail page: the thumbnail with a play
 * overlay, rendered as an <a> to the watch URL so it works with no JS. assets/feeds.js
 * intercepts the click and swaps in a youtube-nocookie iframe, no third-party DOM loads
 * until the user opts in. The "Watch on YouTube" button beneath it stays as the fallback.
 */
function ytFacade(stream: YtStream): string {
	const bg = stream.thumbHref ? ` style="background-image:url('${escapeHtml(stream.thumbHref)}')"` : "";
	return [
		`${T(2)}<a class="yt-facade" href="${escapeHtml(stream.url)}" data-yt="${escapeHtml(stream.videoId)}" aria-label="Play ${escapeHtml(stream.label)}"${bg}>`,
		`${T(3)}<span class="yt-play" aria-hidden="true"></span>`,
		`${T(2)}</a>`,
	].join("\n");
}

// ── Feed (Osiris) cams ────────────────────────────────────────────────────────
// A third source with its own flat gallery (one card per cam, like the streams
// gallery). Hybrid rendering: the gallery card shows a baked, same-origin thumbnail
// exactly like the other sources, but the detail page embeds the LIVE feed, an
// auto-refreshing <img> (jpg), a <video> (mp4/hls, hls via the vendored hls.js), or,
// for iframe/external-only cams, just a "view live" link (we never load third-party
// DOM). Every live element degrades to that link on error.

export interface FeedCam {
	id: string;
	slug: string;
	/** Display title: the cam's name, else its id. */
	name: string;
	source: string | null;
	/** Device fingerprint derived from the feed URL (see fingerprint.ts), or null. */
	product: string | null;
	city: string | null;
	country: string | null;
	lat: number | null;
	lng: number | null;
	feedKind: FeedKind;
	/** URL the detail page embeds (jpg/mp4/hls) or links (link kind). */
	liveUrl: string;
	/** Optional human-facing viewer page (preferred "view live" target). */
	externalUrl: string | null;
	/** URL of the already-extracted thumbnail file, or "" when none was captured. */
	thumbHref: string;
	thumbAlt: string;
	/** Free-form tags applied to this cam (see the unified `tags` table), sorted. */
	tags: string[];
}

/** Map a stored feed row (plus its extracted image URL and tags) into a view model. */
export function toFeedCam(row: StoredFeedRow, thumbHref: string, tags: string[] = [], slug: string = feedSlug(row.id)): FeedCam {
	const name = (row.name && row.name.trim()) || row.id;
	return {
		id: row.id,
		slug,
		name,
		source: row.source,
		product: row.product ?? null,
		city: row.city,
		country: row.country_name,
		lat: row.lat,
		lng: row.lng,
		feedKind: row.feed_kind,
		liveUrl: row.live_url,
		externalUrl: row.external_url,
		thumbHref,
		thumbAlt: `Snapshot from ${name}`,
		tags,
	};
}

/** Plain-text "city, country", de-duped when a source uses the country as a placeholder city. Callers escape. */
function feedLoc(cam: FeedCam): string {
	const city = cam.city?.trim() ?? "";
	const country = cam.country?.trim() ?? "";
	const parts = city && country && city.toLowerCase() === country.toLowerCase() ? [country] : [city, country];
	return parts.filter((v) => v !== "").join(", ");
}

/** Human label for a cam's feed kind, shown in the detail metadata table. */
function feedKindLabel(kind: FeedKind): string {
	switch (kind) {
		case "jpg":
			return "Auto-refreshing snapshot";
		case "mjpeg":
			return "Live MJPEG stream";
		case "mp4":
			return "Live video (MP4)";
		case "hls":
			return "Live video (HLS)";
		case "link":
			return "Snapshot (view live externally)";
	}
}

/**
 * One feed card for the gallery. Same shape as a host/stream card (a CSS-background
 * thumbnail figure with a corner badge, a one-line title, a location subtitle) so all
 * three galleries render identically; here the title is the cam name and the subtitle
 * is its location. A cam with no captured thumbnail (link cams, dead feeds) shows the
 * plain black figure.
 */
export function renderFeedCard(cam: FeedCam, opts: RenderOpts = {}): string {
	const loc = escapeHtml(feedLoc(cam));
	const locLine = loc ? `\n${T(1)}<p class="loc">${loc}</p>` : "";
	const devAttrs = opts.dev ? ` data-kind="feed" data-ref="${escapeHtml(cam.id)}"` : "";
	// Badge the card with its transport (the same label the detail page uses), so two cards
	// of the same view (e.g. an HLS and an MJPEG feed) don't read as dupes. `link` cams
	// aren't a real transport (unembeddable still + "view live"), so they go unbadged.
	const badge =
		cam.feedKind !== "link"
			? `\n${T(2)}<span class="badge">${escapeHtml(feedKindLabel(cam.feedKind))}</span>`
			: "";
	const route = feedRoute(cam.slug);
	return [
		`<a class="card" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}"${devAttrs}>`,
		`${T(1)}<figure role="img" aria-label="${escapeHtml(cam.thumbAlt)}" style="background-image:url('${escapeHtml(cam.thumbHref)}')">${badge}`,
		`${T(1)}</figure>`,
		`${T(1)}<h2>`,
		`${T(2)}<span class="dn-line dn-name">${escapeHtml(cam.name)}</span>`,
		`${T(1)}</h2>${locLine}`,
		`</a>`,
	].join("\n");
}

/** Inner-<main> content for a feeds gallery page: the card grid plus the pager. */
export function renderFeedMain(cams: FeedCam[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (cams.length === 0) {
		return `<p class="empty">No feed cams stored yet. Run <code>bun run osiris</code> first.</p>`;
	}
	const cards = cams.map((c) => indentBlock(renderFeedCard(c, opts), 1)).join("\n");
	const pager = renderFeedPager(page, totalPages);
	return [`<section class="gallery">`, cards, `</section>`, ...(pager ? [pager] : [])].join("\n");
}

/**
 * The live media element for a detail page, chosen by feed kind. The `poster` /
 * initial `src` / background is the baked same-origin thumbnail so there's an instant
 * frame and no broken-image flash; the client (feeds.js) then drives the live feed
 * (cache-busting the jpg <img>, streaming the mjpeg <img>, attaching hls.js to the
 * <video>). `link` cams show just the still; the "View live" button is the way through.
 */
function feedMedia(cam: FeedCam): string {
	const alt = escapeHtml(cam.thumbAlt);
	const poster = cam.thumbHref ? ` poster="${escapeHtml(cam.thumbHref)}"` : "";
	switch (cam.feedKind) {
		case "jpg": {
			const src = cam.thumbHref ? ` src="${escapeHtml(cam.thumbHref)}"` : "";
			return `${T(2)}<img class="live-img" data-refresh="${escapeHtml(cam.liveUrl)}"${src} alt="${alt}" referrerpolicy="no-referrer" />`;
		}
		case "mjpeg": {
			// A multipart <img> plays a Motion JPEG stream natively, no JS needed. The baked
			// still rides as the background (instant frame, and the fallback if the stream is
			// blocked/dead); feeds.js also swaps src to it on error.
			const bg = cam.thumbHref ? ` style="background-image:url('${escapeHtml(cam.thumbHref)}')"` : "";
			const still = cam.thumbHref ? ` data-still="${escapeHtml(cam.thumbHref)}"` : "";
			return `${T(2)}<img class="live-img" data-mjpeg src="${escapeHtml(cam.liveUrl)}"${still}${bg} alt="${alt}" referrerpolicy="no-referrer" />`;
		}
		case "mp4":
			return `${T(2)}<video class="live-video" src="${escapeHtml(cam.liveUrl)}" autoplay muted loop playsinline controls${poster}></video>`;
		case "hls":
			return `${T(2)}<video class="live-video" data-hls="${escapeHtml(cam.liveUrl)}" autoplay muted playsinline controls${poster}></video>`;
		case "link":
			// Not embeddable (http feed on our https site, or a viewer page): just the baked
			// still. The "View live" button below is the way through.
			return cam.thumbHref ? `${T(2)}<img class="live-img" src="${escapeHtml(cam.thumbHref)}" alt="${alt}" />` : "";
	}
}

/**
 * Inner-<main> content for a feed cam's detail page: the live media (or a
 * placeholder) with a "View live" button, then a lean metadata table. The button
 * targets the human-facing page when there is one, else the raw feed URL.
 */
export function renderFeedDetail(cam: FeedCam, opts: RenderOpts = {}): string {
	const media = feedMedia(cam);
	const liveHref = cam.externalUrl ?? cam.liveUrl;
	// Dev hook on the figure (a `.shot`, like host pages) so right-click tags this cam.
	const devAttrs = opts.dev ? ` data-kind="feed" data-ref="${escapeHtml(cam.id)}"` : "";
	const figure = [
		`${T(1)}<figure class="shot"${devAttrs}>`,
		media,
		`${T(2)}<a class="btn" href="${escapeHtml(liveHref)}" target="_blank" rel="noopener noreferrer">`,
		indentBlock(btnLayers("View live"), 2),
		`${T(2)}</a>`,
		`${T(1)}</figure>`,
	].join("\n");

	const rows: string[] = [];
	const push = (label: string, value: string | null | undefined): void => {
		if (value && String(value).trim() !== "") rows.push(metaRow(label, escapeHtml(value)));
	};
	push("Source", cam.source);
	push("Fingerprint", cam.product);
	push("Location", feedLoc(cam));
	if (cam.lat != null && cam.lng != null) push("Coordinates", `${cam.lat}, ${cam.lng}`);
	push("Type", feedKindLabel(cam.feedKind));
	if (cam.tags.length) rows.push(metaRow("Tags", renderTagLinks(cam.tags, opts.slugForTag)));

	return [
		`<article class="host">`,
		`${T(1)}<h2>${escapeHtml(cam.name)}</h2>`,
		`${T(1)}<div class="shots">`,
		indentBlock(figure, 1),
		`${T(1)}</div>`,
		`${T(1)}<table class="meta">`,
		`${T(2)}<tbody>`,
		indentBlock(rows.join("\n"), 3),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		`${T(1)}<a class="back" href="${urlOf(FEEDS)}" hx-get="${snipUrlOf(FEEDS)}" hx-push-url="${urlOf(FEEDS)}">&larr; Back to feeds</a>`,
		`</article>`,
	].join("\n");
}

// ── Tags cloud ─────────────────────────────────────────────────────────────────
// A cloud of every tag across all three sources (the unified `tags` table), each
// sized by how many entities carry it. Each tag links to its browse page; the count
// rides along in a title tooltip. Sizing is a LOG map from count to a font-size
// percentage (not linear): counts are a long tail (a few tags on hundreds of
// entities, most on a handful), so a linear map crushes the tail against the minimum
// size. ln() spreads the low/mid range so the cloud actually varies.

export interface TagCount {
	tag: string;
	count: number;
}

/** Smallest / largest font-size (percent) a tag maps to; the count range spans these. */
const TAG_MIN_SIZE = 100;
const TAG_MAX_SIZE = 320;

/**
 * Inner-<main> content for the tags page: a cloud of every tag, each an anchor to its
 * browse page (`slugForTag` gives the slug), sized by a log map of its entity count
 * between TAG_MIN_SIZE and TAG_MAX_SIZE. When every tag shares one count the log span
 * is zero, floored to ε so all render at the minimum size. Tags are attacker-controlled
 * (entered via `bun run tag`), so each name is escaped before it lands in the link text
 * and the title attribute.
 */
export function renderTagsMain(tags: TagCount[], slugForTag: (tag: string) => string): string {
	if (tags.length === 0) {
		return `<p class="empty">No tags yet. Tag something with <code>bun run tag &lt;cam|stream|feed&gt; &lt;ref&gt; &lt;tag&gt;</code>, then re-bake.</p>`;
	}
	const logs = tags.map((t) => Math.log(t.count));
	const minLog = Math.min(...logs);
	const span = Math.max(1e-9, Math.max(...logs) - minLog);
	const step = (TAG_MAX_SIZE - TAG_MIN_SIZE) / span;

	const items = tags
		.map((t) => {
			const size = Math.round(TAG_MIN_SIZE + (Math.log(t.count) - minLog) * step);
			const name = escapeHtml(t.tag);
			const route = tagRoute(slugForTag(t.tag));
			const title = `${t.count} ${t.count === 1 ? "entry" : "entries"} tagged ${name}`;
			return `<li><a style="font-size: ${size}%" title="${title}" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}">${name}</a></li>`;
		})
		.join("\n");

	return [
		`<section class="tagcloud">`,
		`${T(1)}<ul class="tags">`,
		indentBlock(items, 2),
		`${T(1)}</ul>`,
		`</section>`,
	].join("\n");
}

// ── Device fingerprints page ─────────────────────────────────────────────────────
// A standalone page with a make → model → count breakdown of every fingerprinted camera,
// built from the `product` field (see fingerprint.ts). A trailing "filter" column links
// each make to its per-vendor gallery (/fingerprints/<vendor>) when that vendor has one.
// Makes group via a rowspan cell; the catch-all "Unidentified"/"Other" makes sink last.

/**
 * Inner-<main> content for the fingerprints page: the make/model/count table, or an
 * empty-state note when nothing is fingerprinted. `groups` come pre-sorted from
 * productBreakdown, each carrying a dominant `vendor`. `vendorsWithGallery` is the set of
 * vendors that actually got a gallery this build; a make is linked (a `.btn` in the
 * "filter" column) only when its vendor is in that set. Every make and model is escaped
 * (models can echo attacker-influenced banner text).
 */
export function renderFingerprintsMain(groups: ProductGroup[], vendorsWithGallery: Set<string> = new Set()): string {
	if (groups.length === 0) {
		return `<p class="empty">No camera fingerprints yet. Run <code>bun run fingerprint --apply</code>, then re-bake.</p>`;
	}
	const totalCams = groups.reduce((n, g) => n + g.total, 0);
	const fmt = (n: number) => n.toLocaleString();

	// The "filter" cell: a `.btn` link to the make's vendor gallery, or empty when that
	// vendor has no gallery (a floor make, or an unfingerprinted DB).
	const filterCell = (g: ProductGroup): string => {
		const v = g.vendor && vendorsWithGallery.has(g.vendor) ? g.vendor : "";
		if (!v) return `${T(2)}<td class="bd-filter" rowspan="${g.models.length}"></td>`;
		const route = vendorRoute(v);
		const btn = [
			`<a class="btn" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}" aria-label="Filter to ${escapeHtml(v)} cameras">`,
			btnLayers("filter"),
			`</a>`,
		].join("\n");
		return `${T(2)}<td class="bd-filter" rowspan="${g.models.length}">\n${indentBlock(btn, 3)}\n${T(2)}</td>`;
	};

	const body = groups
		.map((g) => {
			return g.models
				.map((m, i) => {
					const model = m.model === "—" ? `<span class="bd-none">—</span>` : escapeHtml(m.model);
					const cells = [`${T(2)}<td class="bd-model">${model}</td>`, `${T(2)}<td class="bd-count">${fmt(m.count)}</td>`];
					// The make cell and the filter cell both span all of the make's models.
					const makeCell =
						i === 0
							? `${T(2)}<th scope="rowgroup" rowspan="${g.models.length}" class="bd-make">${escapeHtml(g.make)}<span class="bd-total">${fmt(g.total)}</span></th>\n`
							: "";
					const filter = i === 0 ? `\n${filterCell(g)}` : "";
					return `${T(1)}<tr>\n${makeCell}${cells.join("\n")}${filter}\n${T(1)}</tr>`;
				})
				.join("\n");
		})
		.join("\n");

	return [
		`<section class="breakdown">`,
		`${T(1)}<h2>Device fingerprints</h2>`,
		`${T(1)}<p class="bd-sub">${fmt(totalCams)} cameras across ${groups.length} makes, identified from Shodan banners and feed URLs.</p>`,
		`${T(1)}<table class="bd-table">`,
		`${T(2)}<thead><tr><th scope="col">Make</th><th scope="col">Model</th><th scope="col" class="bd-count">Cameras</th><th scope="col" class="bd-filter">filter</th></tr></thead>`,
		`${T(2)}<tbody>`,
		indentBlock(body, 2),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		`</section>`,
	].join("\n");
}

// ── Tag browse pages ─────────────────────────────────────────────────────────────
// One paginated page per tag, a blended gallery of every entity carrying it: cams,
// then streams, then feed (each kind newest-first, from build.ts). Reuses the same
// card renderers as the galleries, so a tag page looks like any other gallery. Real
// <a>/hx-get links throughout, so browsing works with no JS (only tagging is JS-only).

/** One entity on a tag browse page, tagged with its kind so the right card renderer is used. */
export type TagItem =
	| { kind: "cam"; host: Host }
	| { kind: "stream"; stream: YtStream }
	| { kind: "feed"; cam: FeedCam };

/** Render one browse-page card, dispatching on the item's kind. */
function renderTagCard(item: TagItem, opts: RenderOpts = {}): string {
	switch (item.kind) {
		case "cam":
			return renderHostCard(item.host, opts);
		case "stream":
			return renderYtCard(item.stream, opts);
		case "feed":
			return renderFeedCard(item.cam, opts);
	}
}

/** Numbered pager for a tag browse page (URL builders closed over the tag's slug). */
export function renderTagPager(cur: number, total: number, slug: string): string {
	return renderPagerWith(cur, total, (p) => urlOf(tagPage(slug, p)), (p) => snipUrlOf(tagPage(slug, p)));
}

/** Inner-<main> content for a tag browse page: the blended card grid plus the pager. */
export function renderTagBrowseMain(
	tag: string,
	items: TagItem[],
	page: number,
	totalPages: number,
	slug: string,
	opts: RenderOpts = {},
): string {
	if (items.length === 0) {
		return `<p class="empty">Nothing tagged <strong>${escapeHtml(tag)}</strong> is visible right now.</p>`;
	}
	const cards = items.map((it) => indentBlock(renderTagCard(it, opts), 1)).join("\n");
	const pager = renderTagPager(page, totalPages, slug);
	return [
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
		`<a class="back" href="${urlOf(TAGS)}" hx-get="${snipUrlOf(TAGS)}" hx-push-url="${urlOf(TAGS)}">&larr; All tags</a>`,
	].join("\n");
}

// ── All-kinds gallery + per-vendor galleries ──────────────────────────────────
// Both reuse the blended TagItem cards (renderTagCard dispatches cam/stream/feed) and a
// numbered pager, so they look like any other gallery. The all-kinds gallery is every
// cams row, newest-discovered first (build.ts orders by first_seen). A vendor gallery is
// the subset whose fingerprint vendor matches, with a heading and a back link to the
// fingerprints breakdown. Cards link to normal detail URLs (the card renderers emit them).

/** Inner-<main> for an all-kinds gallery page: blended cards plus the gallery pager. */
export function renderGalleryMain(items: TagItem[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (items.length === 0) {
		return `<p class="empty">Nothing stored yet. Run <code>bun run scrape</code>, <code>bun run youtube</code>, or <code>bun run osiris</code> first.</p>`;
	}
	const cards = items.map((it) => indentBlock(renderTagCard(it, opts), 1)).join("\n");
	const pager = renderGalleryPager(page, totalPages);
	return [`<section class="gallery">`, cards, `</section>`, ...(pager ? [pager] : [])].join("\n");
}

/** Inner-<main> for a per-vendor fingerprint gallery: a heading, blended cards, the vendor pager, and a back link. */
export function renderVendorMain(vendor: string, items: TagItem[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	const back = `<a class="back" href="${urlOf(FINGERPRINTS)}" hx-get="${snipUrlOf(FINGERPRINTS)}" hx-push-url="${urlOf(FINGERPRINTS)}">&larr; All fingerprints</a>`;
	if (items.length === 0) {
		return [`<p class="empty">No <strong>${escapeHtml(vendor)}</strong> cameras are visible right now.</p>`, back].join("\n");
	}
	const cards = items.map((it) => indentBlock(renderTagCard(it, opts), 1)).join("\n");
	const pager = renderVendorPager(page, totalPages, vendor);
	return [
		`<h2 class="vendor-title">${escapeHtml(vendor)} cameras</h2>`,
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
		back,
	].join("\n");
}

// ── World map ────────────────────────────────────────────────────────────────
// A single page plotting every geolocated camera (all three sources) as a dot on a
// baked SVG world map. The country outlines (worldmap.ts) and the dots share one
// viewBox, so the whole thing is one inert SVG: hover a dot for its location (native
// <title>), click it to open that cam (a real <a>, htmx-swapped when JS is on).
// assets/map.js adds drag-to-pan / wheel-to-zoom by nudging the viewBox; with no JS
// it stays a fixed world view, still fully clickable.

export interface MapPoint {
	/** Projected viewBox coordinates (see project()). */
	x: number;
	y: number;
	/** Detail-page pretty URL: the no-JS href and the pushed history entry. */
	href: string;
	/** Detail-page snippet URL: the htmx swap target. */
	snip: string;
	/** Hover label: the cam's location, else its name. */
	title: string;
}

/** Trim a trailing ".0" so projected coords stay compact across ~10k dots. */
const mapRound = (n: number): string => {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/**
 * Inner-<main> for the map page: one SVG holding the world outlines and a dot per
 * geolocated camera. Each dot is an <a> to the cam's detail page (a plain link
 * without JS, an htmx body-swap with it) carrying a <title> for a native hover
 * tooltip. `total` is only for the SVG's accessible label.
 */
export function renderMapMain(points: MapPoint[], total: number): string {
	if (points.length === 0) {
		return `<p class="empty">No geolocated cameras yet. Scrape cams, add feed, or assign stream coordinates with <code>bun run geo</code>, then re-bake.</p>`;
	}
	const land = WORLD_PATHS.map((d) => `${T(3)}<path d="${d}" />`).join("\n");
	const dots = points
		.map(
			(p) =>
				`${T(3)}<a href="${p.href}" hx-get="${p.snip}" hx-push-url="${p.href}"><circle cx="${mapRound(p.x)}" cy="${mapRound(p.y)}" r="1.4"><title>${escapeHtml(p.title)}</title></circle></a>`,
		)
		.join("\n");
	return [
		`<section class="mapwrap">`,
		`${T(1)}<p class="maphint">${total.toLocaleString()} geolocated cameras &middot; drag to pan, scroll to zoom, click a dot to open it</p>`,
		`${T(1)}<svg class="worldmap" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet" aria-label="World map of ${total.toLocaleString()} geolocated cameras">`,
		`${T(2)}<g class="land" aria-hidden="true">`,
		land,
		`${T(2)}</g>`,
		`${T(2)}<g class="dots">`,
		dots,
		`${T(2)}</g>`,
		`${T(1)}</svg>`,
		`</section>`,
	].join("\n");
}

export function renderTipsMain(): string {
	const FRESHPROXIES= `
<h3 id="fresh-proxies">Fresh proxies</h3>
<blockquote class="admonition caution">
	<p class="admonition-label">Caution</p>
	<p>i don't suggest poking around other people's webcams (whether open or not) using your real ip. you should probably use a <a href="https://docs.seedboxes.cc/gettingstarted/how-to-use-your-VPN-service/" target="_blank" rel="noopener noreferrer">a vpn</a> or a proxy. i like <a href="https://github.com/rofl0r/proxychains-ng/" target="_blank" rel="noopener noreferrer">proxychains-ng</a>. but the app only helps you use them; you need to provide your own list of proxies. The "<a href="https://github.com/vakhov/fresh-proxy-list">Fresh Proxies</a>" project publishes new ones daily. i wrote this bash script to automate the process of downloading and formatting them into a valid configuration file.<p>
</blockquote>
<pre class="shiki shiki-themes balanced-light balanced-dark" style="background-color:#f4f6f8;--shiki-dark-bg:#161925;color:#2b2f3a;--shiki-dark:#c6cad6" tabindex="0"><code><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#!/usr/bin/env bash</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># freshproxies: fetch fresh public proxies and print a complete proxychains-ng</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># config to stdout (or write it atomically with -o).</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># author: xero (https://x-e.ro)</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># sources: https://vakhov.github.io/fresh-proxy-list/</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># usage:</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#   ./freshproxies > ~/.config/proxychains/config</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#   sudo ./freshproxies -o /etc/proxychains.conf</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#   ./freshproxies --types "socks5,socks4" --chain round_robin_chain --len 2</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic">#</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">set</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -euo</span><span style="color:#00883C;--shiki-dark:#00883C"> pipefail</span></span><span class="line"></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># Overridable via env for testing / mirrors.</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">BASE_URL</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">FRESHPROXIES_BASE_URL</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-</span><span style="color:#0179CF;--shiki-dark:#0179CF">https</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">://</span><span style="color:#0179CF;--shiki-dark:#0179CF">vakhov</span><span style="color:#00883C;--shiki-dark:#00883C">.</span><span style="color:#0179CF;--shiki-dark:#0179CF">github</span><span style="color:#00883C;--shiki-dark:#00883C">.</span><span style="color:#0179CF;--shiki-dark:#0179CF">io</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">/</span><span style="color:#0179CF;--shiki-dark:#0179CF">fresh-proxy-list</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">CURL_MAX_TIME</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">FRESHPROXIES_CURL_MAX_TIME</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-</span><span style="color:#0179CF;--shiki-dark:#0179CF">20</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># Defaults. A zero-arg run = dump every proxy, one random proxy per connection.</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">CHAIN</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"random_chain"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">CHAINLEN</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">1</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">TYPES</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"socks5 socks4 http https"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">OUTPUT</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">""</span></span><span class="line"></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">SCRIPT_DIR</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">cd</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> --</span><span style="color:#00883C;--shiki-dark:#00883C"> "$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">dirname</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> --</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">BASH_SOURCE</span><span style="color:#00883C;--shiki-dark:#00883C">[0]</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">")" &#x26;&#x26; </span><span style="color:#007EAB;--shiki-dark:#007EAB">pwd</span><span style="color:#00883C;--shiki-dark:#00883C">)"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">TEMPLATE</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$SCRIPT_DIR</span><span style="color:#00883C;--shiki-dark:#00883C">/proxychains-default.conf"</span></span><span class="line"></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">die() { </span><span style="color:#007EAB;--shiki-dark:#007EAB">printf</span><span style="color:#00883C;--shiki-dark:#00883C"> 'freshproxies: %s\\n'</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$1</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> >&#x26;2</span><span style="color:#BE5900;--shiki-dark:#BE5900">; </span><span style="color:#007EAB;--shiki-dark:#007EAB">exit</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${2</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-</span><span style="color:#0179CF;--shiki-dark:#0179CF">1}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#BE5900;--shiki-dark:#BE5900">; }</span></span><span class="line"></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">usage() {</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  cat</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> &#x3C;&#x3C;</span><span style="color:#00883C;--shiki-dark:#00883C">'EOF'</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">freshproxies — generate a proxychains-ng config from fresh public proxies</span></span><span class="line"></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">USAGE:</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  freshproxies [options]            print config to stdout</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  freshproxies -o FILE [options]    write config atomically to FILE</span></span><span class="line"></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">OPTIONS:</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  -o, --output FILE   write to FILE (atomic; safe for /etc) instead of stdout</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">      --chain MODE    random_chain (default) | strict_chain | dynamic_chain | round_robin_chain</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">      --len N         chain_len value (default 1; only used by random/round_robin)</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">      --types LIST    subset of: socks5 socks4 http https (default: all)</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">      --template FILE header template (default: proxychains-default.conf next to script)</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  -h, --help          show this help</span></span><span class="line"></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">EXAMPLES:</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  freshproxies > ~/.config/proxychains/config</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  sudo freshproxies -o /etc/proxychains.conf</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  freshproxies --types "socks5,socks4"</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">EOF</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">}</span></span><span class="line"></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># Full documented header generated only when the bundled conf is missing (e.g. the</span></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># script was copied somewhere on its own), so output stays complete and portable.</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">embedded_header() {</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  cat</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> &#x3C;&#x3C;</span><span style="color:#00883C;--shiki-dark:#00883C">'PCHDR'</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># proxychains.conf  VER 4.x</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># HTTP, SOCKS4a, SOCKS5 tunneling proxifier with DNS.</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">#</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># Examples:</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># socks5 192.168.67.78 1080 lamer secret</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># http   192.168.89.3  8080 justu hidden</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># socks4 192.168.1.49  1080</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># http   192.168.39.93 8080</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">#</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># proxy types: http, socks4, socks5, raw</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># * raw: The traffic is simply forwarded to the proxy without modification.</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C"># ( auth types supported: "basic"-http  "user/pass"-socks )</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">#</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">PCHDR</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">}</span></span><span class="line"></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">while</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> [[ </span><span style="color:#0179CF;--shiki-dark:#0179CF">$#</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> -gt</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 0</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ]]; </span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">do</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  case</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$1</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> in</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    -o</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#00883C;--shiki-dark:#00883C">--output</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">  shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#0179CF;--shiki-dark:#0179CF">OUTPUT</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${1</span><span style="color:#00883C;--shiki-dark:#00883C">-</span><span style="color:#0179CF;--shiki-dark:#0179CF">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;   [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$OUTPUT</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">   ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "-o/--output requires a value"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    --chain</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">      shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#0179CF;--shiki-dark:#0179CF">CHAIN</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${1</span><span style="color:#00883C;--shiki-dark:#00883C">-</span><span style="color:#0179CF;--shiki-dark:#0179CF">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;    [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAIN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">    ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "--chain requires a value"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    --len</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">        shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#0179CF;--shiki-dark:#0179CF">CHAINLEN</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${1</span><span style="color:#00883C;--shiki-dark:#00883C">-</span><span style="color:#0179CF;--shiki-dark:#0179CF">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAINLEN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "--len requires a value"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    --types</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">      shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#0179CF;--shiki-dark:#0179CF">TYPES</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${1</span><span style="color:#00883C;--shiki-dark:#00883C">-</span><span style="color:#0179CF;--shiki-dark:#0179CF">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;    [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$TYPES</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">    ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "--types requires a value"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    --template</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">   shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#0179CF;--shiki-dark:#0179CF">TEMPLATE</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">\${1</span><span style="color:#00883C;--shiki-dark:#00883C">-</span><span style="color:#0179CF;--shiki-dark:#0179CF">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$TEMPLATE</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "--template requires a value"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    -h</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#00883C;--shiki-dark:#00883C">--help</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">    usage</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#007EAB;--shiki-dark:#007EAB">exit</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 0</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    --</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">           shift</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">break</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    -</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">*</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">           usage</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> >&#x26;2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#007EAB;--shiki-dark:#007EAB">die</span><span style="color:#00883C;--shiki-dark:#00883C"> "unknown option: </span><span style="color:#0179CF;--shiki-dark:#0179CF">$1</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">    *)</span><span style="color:#007EAB;--shiki-dark:#007EAB">            usage</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> >&#x26;2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#007EAB;--shiki-dark:#007EAB">die</span><span style="color:#00883C;--shiki-dark:#00883C"> "unexpected argument: </span><span style="color:#0179CF;--shiki-dark:#0179CF">$1</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  esac</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  shift</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">done</span></span><span class="line"></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># validation</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">case</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAIN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> in</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">  random_chain</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#00883C;--shiki-dark:#00883C">strict_chain</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#00883C;--shiki-dark:#00883C">dynamic_chain</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#00883C;--shiki-dark:#00883C">round_robin_chain</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ;;</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">  *)</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "invalid --chain '</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAIN</span><span style="color:#00883C;--shiki-dark:#00883C">' (random_chain|strict_chain|dynamic_chain|round_robin_chain)"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">esac</span></span><span class="line"><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">[[ </span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAINLEN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> =~</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ^[1-9][0-9]</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">*</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">$ ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "--len must be a positive integer (got '</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAINLEN</span><span style="color:#00883C;--shiki-dark:#00883C">')"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">TYPES</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">TYPES</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">//</span><span style="color:#00883C;--shiki-dark:#00883C">,</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">/</span><span style="color:#4871D5;--shiki-dark:#4871D5"> }</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">tmp</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">mktemp</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">TMPDIR</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-/</span><span style="color:#0179CF;--shiki-dark:#0179CF">tmp</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">/freshproxies.XXXXXX")"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">final</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">mktemp</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">TMPDIR</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-/</span><span style="color:#0179CF;--shiki-dark:#0179CF">tmp</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">/freshproxies.XXXXXX")"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">out_tmp</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">""</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">cleanup() { </span><span style="color:#007EAB;--shiki-dark:#007EAB">rm</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -f</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$tmp</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$final</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#4871D5;--shiki-dark:#4871D5">\${</span><span style="color:#0179CF;--shiki-dark:#0179CF">out_tmp</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">:-</span><span style="color:#4871D5;--shiki-dark:#4871D5">}</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#BE5900;--shiki-dark:#BE5900">; }</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">trap</span><span style="color:#00883C;--shiki-dark:#00883C"> cleanup</span><span style="color:#00883C;--shiki-dark:#00883C"> EXIT</span></span><span class="line"></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">fetch_list() {</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  local</span><span style="color:#0179CF;--shiki-dark:#0179CF"> emit</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$1</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF"> file</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$2</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF"> body</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  if </span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">body</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$(</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">curl</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> -fsL</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> --max-time</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$CURL_MAX_TIME</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">" "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$BASE_URL</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">/</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$file</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">" </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">2></span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">/dev/null)"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">; then</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">    printf</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> '%s\\n'</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$body</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> |</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> tr</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> -d</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> '\\r'</span><span style="color:#A457B5;--shiki-light-font-weight:bold;--shiki-dark:#A457B5;--shiki-dark-font-weight:bold"> \\</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">      |</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> awk</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> -F:</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> -v</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> t="</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$emit</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> '/^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+:[0-9]+$/ { print t, $1, $2 }'</span><span style="color:#A457B5;--shiki-light-font-weight:bold;--shiki-dark:#A457B5;--shiki-dark-font-weight:bold"> \\</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">      >></span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$tmp</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  else</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">    printf</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> 'freshproxies: warning: could not fetch %s (skipping)\\n'</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$file</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> >&#x26;2</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  fi</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">}</span></span><span class="line"></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">for</span><span style="color:#0179CF;--shiki-dark:#0179CF"> t</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> in</span><span style="color:#0179CF;--shiki-dark:#0179CF"> $TYPES</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">; </span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">do</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  case</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$t</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> in</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    socks5</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB"> fetch_list</span><span style="color:#00883C;--shiki-dark:#00883C"> socks5</span><span style="color:#00883C;--shiki-dark:#00883C"> socks5.txt</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    socks4</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB"> fetch_list</span><span style="color:#00883C;--shiki-dark:#00883C"> socks4</span><span style="color:#00883C;--shiki-dark:#00883C"> socks4.txt</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    http</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">   fetch_list</span><span style="color:#00883C;--shiki-dark:#00883C"> http</span><span style="color:#00883C;--shiki-dark:#00883C">   http.txt</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    https</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">)</span><span style="color:#007EAB;--shiki-dark:#007EAB">  fetch_list</span><span style="color:#00883C;--shiki-dark:#00883C"> http</span><span style="color:#00883C;--shiki-dark:#00883C">   https.txt</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;   </span><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># proxychains has no https type</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">    *)</span><span style="color:#007EAB;--shiki-dark:#007EAB">      die</span><span style="color:#00883C;--shiki-dark:#00883C"> "invalid type '</span><span style="color:#0179CF;--shiki-dark:#0179CF">$t</span><span style="color:#00883C;--shiki-dark:#00883C">' in --types (use: socks5 socks4 http https)"</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 2</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">;;</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  esac</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">done</span></span><span class="line"></span><span class="line"><span style="color:#8A90A0;--shiki-light-font-style:italic;--shiki-dark:#5B6478;--shiki-dark-font-style:italic"># deduplication</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">awk</span><span style="color:#00883C;--shiki-dark:#00883C"> '!seen[$0]++'</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$tmp</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ></span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$final</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">count</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">wc</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -l</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> &#x3C;</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$final</span><span style="color:#00883C;--shiki-dark:#00883C">" </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">|</span><span style="color:#007EAB;--shiki-dark:#007EAB"> tr</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -d</span><span style="color:#00883C;--shiki-dark:#00883C"> '[:space:]')"</span></span><span class="line"><span style="color:#2B2F3A;--shiki-dark:#C6CAD6">[[ </span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$count</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> -gt</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 0</span><span style="color:#2B2F3A;--shiki-dark:#C6CAD6"> ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-dark:#007EAB"> die</span><span style="color:#00883C;--shiki-dark:#00883C"> "no proxies fetched. refusing to write an empty config"</span></span><span class="line"></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">if [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-f</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$TEMPLATE</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> ]]; then</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  header_raw</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$(</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">awk</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> '/^\\[ProxyList\\]/{exit} {print}' "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$TEMPLATE</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">")"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">else</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  header_raw</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$(</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">embedded_header</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">)"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">fi</span></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">header</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '%s\\n' "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$header_raw</span><span style="color:#00883C;--shiki-dark:#00883C">" </span><span style="color:#A457B5;--shiki-dark:#A457B5">\\</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">  |</span><span style="color:#007EAB;--shiki-dark:#007EAB"> sed</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -E</span><span style="color:#00883C;--shiki-dark:#00883C"> 's/^(strict_chain|dynamic_chain|round_robin_chain|random_chain|chain_len)/#&#x26;/')"</span></span><span class="line"></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">chain_block</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAIN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">if [[ </span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$CHAIN</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ==</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "random_chain"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ||</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$CHAIN</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ==</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "round_robin_chain"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> ]]; then</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  chain_block</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$chain_block</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$'</span><span style="color:#A457B5;--shiki-light-font-weight:bold;--shiki-dark:#A457B5;--shiki-dark-font-weight:bold">\\n</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">'"chain_len = </span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$CHAINLEN</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">fi</span></span><span class="line"></span><span class="line"><span style="color:#0179CF;--shiki-dark:#0179CF">now</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-dark:#00883C">"$(</span><span style="color:#007EAB;--shiki-dark:#007EAB">date</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -u</span><span style="color:#00883C;--shiki-dark:#00883C"> '+%Y-%m-%dT%H:%MZ')"</span></span><span class="line"></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">render() {</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '%s\\n'</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$header</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '\\n# --- chain mode (set by freshproxies) ---\\n'</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '%s\\n'</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$chain_block</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '\\n# generated by freshproxies | %s proxies | chain=%s len=%s | %s\\n'</span><span style="color:#A457B5;--shiki-dark:#A457B5"> \\</span></span><span class="line"><span style="color:#00883C;--shiki-dark:#00883C">    "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$count</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAIN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$CHAINLEN</span><span style="color:#00883C;--shiki-dark:#00883C">"</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$now</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  printf</span><span style="color:#00883C;--shiki-dark:#00883C"> '%s\\n'</span><span style="color:#00883C;--shiki-dark:#00883C"> '[ProxyList]'</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">  cat</span><span style="color:#00883C;--shiki-dark:#00883C"> "</span><span style="color:#0179CF;--shiki-dark:#0179CF">$final</span><span style="color:#00883C;--shiki-dark:#00883C">"</span></span><span class="line"><span style="color:#BE5900;--shiki-dark:#BE5900">}</span></span><span class="line"></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">if [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-n</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$OUTPUT</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> ]]; then</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  dir</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$(</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">dirname</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> --</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$OUTPUT</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">")"</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">  [[ </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">-d</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$dir</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold"> ]] </span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">||</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> die</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "output directory does not exist: </span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$dir</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  out_tmp</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"$(</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">mktemp</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$dir</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">/.freshproxies.XXXXXX")"</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> \\</span></span><span class="line"><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">    ||</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> die</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "cannot create temp file in </span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$dir</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> (permission? try sudo)"</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">  render</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ></span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$out_tmp</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">  mv</span><span style="color:#BE4C89;--shiki-light-font-weight:bold;--shiki-dark:#BE4C89;--shiki-dark-font-weight:bold"> --</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$out_tmp</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$OUTPUT</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ||</span><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold"> die</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "could not move config into place: </span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$OUTPUT</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span></span><span class="line"><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">  out_tmp</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold">=</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">""</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">  printf</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> 'freshproxies: wrote %s proxies to %s\\n'</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$count</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold"> "</span><span style="color:#0179CF;--shiki-light-font-weight:bold;--shiki-dark:#0179CF;--shiki-dark-font-weight:bold">$OUTPUT</span><span style="color:#00883C;--shiki-light-font-weight:bold;--shiki-dark:#00883C;--shiki-dark-font-weight:bold">"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> >&#x26;2</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">else</span></span><span class="line"><span style="color:#007EAB;--shiki-light-font-weight:bold;--shiki-dark:#007EAB;--shiki-dark-font-weight:bold">  render</span></span><span class="line"><span style="color:#6969D4;--shiki-light-font-weight:bold;--shiki-dark:#6969D4;--shiki-dark-font-weight:bold">fi</span></span><span class="line"></span></code></pre>
<h4 id="usage-examples">usage examples</h4><p>many programs work transparently by just prefixing the command with <kbd>proxychains4</kbd>:</p><div class="snippet"><pre class="shiki shiki-themes balanced-light balanced-dark" style="background-color:#f4f6f8;--shiki-dark-bg:#161925;color:#2b2f3a;--shiki-dark:#c6cad6" tabindex="0"><code><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">freshproxies</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ></span><span style="color:#00883C;--shiki-dark:#00883C"> ~/.config/proxychains/config</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">proxychains4</span><span style="color:#00883C;--shiki-dark:#00883C"> curl</span><span style="color:#00883C;--shiki-dark:#00883C"> icanhazip.com</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">proxychains4</span><span style="color:#00883C;--shiki-dark:#00883C"> firefox</span></span></code></pre></div><p>To use with <strong>google Chrome</strong>, you must disable sandboxing, otherwise the preloaded proxying library crashes.</p><div class="snippet"><pre class="shiki shiki-themes balanced-light balanced-dark" style="background-color:#f4f6f8;--shiki-dark-bg:#161925;color:#2b2f3a;--shiki-dark:#c6cad6" tabindex="0"><code><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">freshproxies</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ></span><span style="color:#00883C;--shiki-dark:#00883C"> ~/.config/proxychains/config</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">proxychains4</span><span style="color:#00883C;--shiki-dark:#00883C"> google-chrome</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> --no-sandbox</span></span></code></pre></div><p>To run <strong>vlc</strong> media player, you must use a tcp-based socks4/5 proxy in your configuration, as proxychains does not support udp.</p><div class="snippet"><pre class="shiki shiki-themes balanced-light balanced-dark" style="background-color:#f4f6f8;--shiki-dark-bg:#161925;color:#2b2f3a;--shiki-dark:#c6cad6" tabindex="0"><code><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">freshproxies</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> --types</span><span style="color:#00883C;--shiki-dark:#00883C"> "socks5,socks4"</span><span style="color:#008576;--shiki-light-font-weight:bold;--shiki-dark:#008576;--shiki-dark-font-weight:bold"> ></span><span style="color:#00883C;--shiki-dark:#00883C"> ./pchains.cfg</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">proxychains4</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -f</span><span style="color:#00883C;--shiki-dark:#00883C"> ./pchains.cfg</span><span style="color:#00883C;--shiki-dark:#00883C"> vlc</span></span></code></pre></div><p>To use with <strong>nmap</strong> you need the <kbd>-sT</kbd> flags for TCP Connect scans, as SYN/UDP scans require raw sockets that Proxychains cannot route.</p><div class="snippet"><pre class="shiki shiki-themes balanced-light balanced-dark" style="background-color:#f4f6f8;--shiki-dark-bg:#161925;color:#2b2f3a;--shiki-dark:#c6cad6" tabindex="0"><code><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">sudo</span><span style="color:#00883C;--shiki-dark:#00883C"> freshproxies</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -o</span><span style="color:#00883C;--shiki-dark:#00883C"> /etc/proxychains.conf</span></span><span class="line"><span style="color:#007EAB;--shiki-dark:#007EAB">sudo</span><span style="color:#00883C;--shiki-dark:#00883C"> proxychains4</span><span style="color:#00883C;--shiki-dark:#00883C"> nmap</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -sT</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -Pn</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> -p</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 80</span><span style="color:#BE4C89;--shiki-dark:#BE4C89"> 192.168.1.1</span></span></code></pre></div>
`;
	return [`<section class="tips">`, indentBlock(TIPS_HTML.trim(), 1), FRESHPROXIES.trim(), `</section>`].join("\n");
}

/**
 * One import form (DEV-ONLY). Shodan takes pasted JSON (its cameras carry embedded
 * screenshots and no url/title/coords); youtube and mjpeg take a feed URL plus an
 * optional label. HTML5 `required`/`type=url` do the validation; dev-client/dev.js
 * intercepts the submit, POSTs to /__dev/import, and toasts the result. The forms
 * carry no hx-* (submit is a fetch), so htmx never processes them.
 */
export function renderImportForm(type: "shodan" | "youtube" | "mjpeg"): string {
	if (type === "shodan") {
		return [
			`<form class="import-form" data-import-type="shodan">`,
			`${T(1)}<label class="import-label" for="import-json">Shodan JSON</label>`,
			`${T(1)}<textarea id="import-json" class="dev-input import-textarea" name="json" required spellcheck="false" placeholder="paste raw Shodan JSON: a search response, a host lookup, a bare array, or a single banner"></textarea>`,
			`${T(1)}<button type="submit" class="btn"><span class="shadow"></span><span class="edge"></span><span class="front">import</span></button>`,
			`</form>`,
		].join("\n");
	}
	const placeholder = type === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://host/axis-cgi/mjpg/video.cgi";
	return [
		`<form class="import-form" data-import-type="${type}">`,
		`${T(1)}<label class="import-label" for="import-url">feed URL</label>`,
		`${T(1)}<input id="import-url" class="dev-input" type="url" name="url" required autocomplete="off" spellcheck="false" placeholder="${placeholder}" />`,
		`${T(1)}<label class="import-label" for="import-label-input">label <span class="import-opt">(optional)</span></label>`,
		`${T(1)}<input id="import-label-input" class="dev-input" name="label" autocomplete="off" placeholder="display title" />`,
			`${T(1)}<button type="submit" class="btn"><span class="shadow"></span><span class="edge"></span><span class="front">import</span></button>`,
		`</form>`,
	].join("\n");
}

/**
 * Inner-<main> for the DEV-ONLY import view: an "import" title, a row of type buttons
 * (Shodan / YouTube / MJPEG), and the #import-form container holding the default
 * Shodan form. The type buttons hx-get their fragment into #import-form; the explicit
 * hx-target overrides <main>'s inherited target so the title and tabs survive.
 */
export function renderImportMain(): string {
	const tab = (type: string, label: string): string =>
		[
			`<button type="button" class="btn" hx-get="${importFormSnippetUrl(type)}" hx-target="#import-form" hx-swap="innerHTML">`,
			btnLayers(label),
			`</button>`,
		].join("\n");
	return [
		`<section class="home import">`,
		`${T(1)}<h2 class="section-title">import</h2>`,
		`${T(1)}<div class="import-tabs">`,
		indentBlock(tab("shodan", "Shodan"), 2),
		indentBlock(tab("youtube", "YouTube"), 2),
		indentBlock(tab("mjpeg", "MJPEG"), 2),
		`${T(1)}</div>`,
		`${T(1)}<div id="import-form">`,
		indentBlock(renderImportForm("shodan"), 2),
		`${T(1)}</div>`,
		`</section>`,
	].join("\n");
}

// ── Page shell ───────────────────────────────────────────────────────────────

/** Site-wide stat block under the h1, identical on every page. */
export interface SiteStats {
	/** Combined cams+streams+feed total, pre-formatted (toLocaleString). */
	discovered: string;
	/** Build time, e.g. "2026-07-09 @ 10:59" (UTC, no tz label). */
	updated: string;
	/** Refresh cadence, e.g. "6 hrs". */
	interval: string;
}

export interface ShellOpts {
	/** <title> for the full page (host pages differ, for bookmarks/deep links). */
	title: string;
	/** Site-wide stat block shown under the h1; identical on every page. */
	stats: SiteStats;
	/** Inner-<main> content, the exact same string written as the snippet. */
	mainInner: string;
	/** Dev mode: link /__dev/dev.css and load /__dev/dev.js (both served by src/dev.ts). */
	dev?: boolean;
}

/** Wrap inner-<main> content in the full HTML document. */
export function renderShell({ title, stats, mainInner, dev = false }: ShellOpts): string {
	// Header links (brand + nav + the discovered-count link) live outside <main>, so they
	// can't inherit its hx-target:inherited / hx-swap:inherited. Without a resolvable
	// target htmx falls back to a full-page navigation on the href, which loads the whole
	// document (its own <main> included) and appends it. Set both explicitly so these
	// links swap the snippet into <main>, exactly like the in-main links.
	const navAttrs = 'hx-target="main" hx-swap="innerHTML show:top"';
	const ghStat= (label: string, value: string, href: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" target="_blank">${escapeHtml(value)}</a></strong></span>`;
	const statLink = (label: string, value: string, href: string, snip: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">${escapeHtml(value)}</a></strong></span>`;
	const counts = [
		statLink("cameras discovered", stats.discovered, urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS)),
		ghStat("updated", stats.updated, "https://github.com/xero/w3b.cam/deployments"),
		ghStat("fresh scrapes every", stats.interval, "https://github.com/xero/w3b.cam/blob/main/.github/workflows/scrape.yml#L9"),
	].join("");
	const navLink = (href: string, snip: string, label: string, classes:string = ''): string => [
		`<a class="${classes}" href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">`,
		`<svg alt="${label}" aria-label="${label}"><use href="/icons.svg#${label}"></use></svg>`,
		`</a>`,
	].join("");
	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		`${T(1)}<head>`,
		`${T(2)}<meta charset="UTF-8" />`,
		`${T(2)}<meta name="viewport" content="width=device-width, initial-scale=1" />`,
		`${T(2)}<meta name="theme-color" content="${THEME_COLOR}" />`,
		`${T(2)}<title>${escapeHtml(title)}</title>`,
		`${T(2)}<link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />`,
		`${T(2)}<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
		`${T(2)}<link rel="shortcut icon" href="/favicon.ico" />`,
		`${T(2)}<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`,
		`${T(2)}<meta name="apple-mobile-web-app-title" content="${escapeHtml(TITLE)}" />`,
		`${T(2)}<link rel="manifest" href="/site.webmanifest" />`,
		`${T(2)}<link rel="alternate" type="application/rss+xml" title="${escapeHtml(TITLE)} live feed" href="/rss.xml" />`,
		`${T(2)}<link rel="alternate" type="application/atom+xml" title="${escapeHtml(TITLE)} live feed" href="/atom.xml" />`,
		`${T(2)}<link rel="stylesheet" href="/style.css" />`,
		...(dev ? [`${T(2)}<link rel="stylesheet" href="/__dev/dev.css" />`] : []),
		`${T(1)}</head>`,
		`${T(1)}<body>`,
		`${T(2)}<header>`,
		`${T(3)}<div class="brand">`,
		`${T(4)}<h1><a href="${urlOf(HOME)}" hx-get="${snipUrlOf(HOME)}" ${navAttrs} hx-push-url="${urlOf(HOME)}">${escapeHtml(TITLE)}</a></h1>`,
		`${T(4)}<em>internet voyeurism</em>`,
		`${T(3)}</div>`,
		`${T(3)}<nav class="nav">`,
		indentBlock(navLink(urlOf(GALLERY), snipUrlOf(GALLERY), "gallery"), 4),
		indentBlock(navLink(urlOf(HOSTS), snipUrlOf(HOSTS), "hosts"), 4),
		indentBlock(navLink(urlOf(FEEDS), snipUrlOf(FEEDS), "feeds"), 4),
		indentBlock(navLink(urlOf(STREAMS), snipUrlOf(STREAMS), "streams"), 4),
		indentBlock(navLink(urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS), "fingerprints"), 4),
		indentBlock(navLink(urlOf(TAGS), snipUrlOf(TAGS), "tags"), 4),
		indentBlock(navLink(urlOf(MAP), snipUrlOf(MAP), "map"), 4),
		indentBlock(navLink(urlOf(TIPS), snipUrlOf(TIPS), "tips"), 4),
		...(dev ? [indentBlock(navLink(urlOf(IMPORT), snipUrlOf(IMPORT), "import", "dev"), 4)] : []),
		`${T(3)}</nav>`,
		`${T(2)}</header>`,
		`${T(2)}<main hx-target:inherited="main" hx-swap:inherited="innerHTML show:top">`,
		indentBlock(mainInner, 3),
		`${T(2)}</main>`,
		`${T(2)}<footer>`,
		`${T(3)}<p id="syndication">`,
		`${T(4)}<a href="/atom.xml"><svg alt="atom feed" aria-label="atom feed"><use href="/icons.svg#atom"></use></svg></a>`,
		`${T(4)}<a href="/rss.xml"><svg alt="rss feed" aria-label="rss feed"><use href="/icons.svg#rss"></use></svg></a>`,
		`${T(3)}</p>`,
		`${T(3)}<cite><a href="https://3xi.club" target="_blank">3xi.club</a> project by <a href="https://x-e.ro" target="_blank">xero</a></cite>`,
		`${T(3)}<p class="count">${counts}</p>`,
		`${T(2)}</footer>`,
		`${T(2)}<script src="/htmx.min.js"></script>`,
		// Live-feed client on every page (tiny): drives feed detail feeds and must be
		// present however you arrive, including htmx swaps whose snippets carry no script.
		// It loads hls.min.js on demand only when an HLS cam is actually viewed.
		`${T(2)}<script src="/feeds.js" defer></script>`,
		// Map client (tiny): drag-to-pan / wheel-to-zoom for the SVG world map. Like
		// feeds.js it loads on every page and no-ops when no map is present.
		`${T(2)}<script src="/map.js" defer></script>`,
		...(dev ? [`${T(2)}<script src="/__dev/dev.js"></script>`] : []),
		`${T(1)}</body>`,
		"</html>",
		"",
	].join("\n");
}
