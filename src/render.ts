// Pure rendering: DB rows -> HTML strings. No IO here (build.ts does the writing
// and image extraction). Every banner-derived string is attacker-controlled, so it
// is HTML-escaped before interpolation, exactly as the original single-page build did.

import { displayParts, escapeHtml, pickDisplayName } from "./util.ts";
import type { FeedKind, ProductGroup, StoredRow, StoredTrafficRow, StoredYtRow } from "./types.ts";
import { TIPS_HTML } from "./tips.ts";
import { WORLD_PATHS } from "./worldmap.ts";

export const TITLE = "w3b.cam";
export const THEME_COLOR = "#0f1117";

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

/**
 * Filename-safe slug for a host, keyed on its IP. Whitelist, don't blacklist:
 * collapse every run of non-hex-digit chars to a single hyphen. Dots and IPv6
 * colons become hyphens, and anything hostile (`/`, `..`) collapses too, so the
 * result is always traversal-safe. `190.94.18.107` -> `190-94-18-107`.
 */
export function hostSlug(ip: string): string {
	return ip.toLowerCase().replace(/[^0-9a-f]+/g, "-").replace(/^-|-$/g, "");
}

// ── Page / snippet URL helpers ───────────────────────────────────────────────
// Root-relative (served at the domain root by src/serve.ts). index.html is the
// curated homepage (see renderHomeMain), so the cams gallery is uniformly
// paginated: page 1 is page001.html, matching every other page and its snippet.

const pad = (p: number): string => String(p).padStart(3, "0");

/** The homepage lives at index.html; "/" and its snippet reference it. */
export const homeUrl = "/";
export const homeSnippetUrl = "/snips/index.html";

/** Disk filename of full cams gallery page p (uniform: page001.html, page002.html, …). */
export const pageFileName = (p: number): string => `page${pad(p)}.html`;
/** Pretty URL pushed into history for cams gallery page p. */
export const pageUrl = (p: number): string => `/page${pad(p)}.html`;
/** Disk filename of the snippet for cams gallery page p (uniform, includes page 1). */
export const snippetFileName = (p: number): string => `page${pad(p)}.html`;
/** hx-get URL of the snippet for cams gallery page p. */
export const snippetUrl = (p: number): string => `/snips/page${pad(p)}.html`;

export const hostUrl = (slug: string): string => `/${slug}.html`;
export const hostSnippetUrl = (slug: string): string => `/snips/${slug}.html`;

// YouTube streams live on their own paginated gallery (streams.html, then
// streams002.html …) with one detail page per video (yt-<id>.html). Same
// conventions as the index: page 1 is the pretty streams.html, snippets are
// uniformly numbered.

/** Disk filename of full streams page p (page 1 is streams.html). */
export const streamsPageFileName = (p: number): string => (p === 1 ? "streams.html" : `streams${pad(p)}.html`);
/** Pretty URL pushed into history for streams page p. */
export const streamsPageUrl = (p: number): string => `/${p === 1 ? "streams.html" : `streams${pad(p)}.html`}`;
/** Disk filename of the snippet for streams page p (uniform, includes page 1). */
export const streamsSnippetFileName = (p: number): string => `streams${pad(p)}.html`;
/** hx-get URL of the snippet for streams page p. */
export const streamsSnippetUrl = (p: number): string => `/snips/streams${pad(p)}.html`;

/** Filename-safe slug for a video's detail page. Ids are already [A-Za-z0-9_-]; this is defensive. */
export const ytSlug = (id: string): string => `yt-${id.replace(/[^A-Za-z0-9_-]+/g, "")}`;

export const ytUrl = (slug: string): string => `/${slug}.html`;
export const ytSnippetUrl = (slug: string): string => `/snips/${slug}.html`;

// Traffic (Osiris) cams have their own paginated gallery (traffic.html, then
// traffic002.html …) with one detail page per cam (t-<id>.html). Same conventions
// as the streams gallery: page 1 is the pretty traffic.html, snippets are uniformly
// numbered.

/** Disk filename of full traffic page p (page 1 is traffic.html). */
export const trafficPageFileName = (p: number): string => (p === 1 ? "traffic.html" : `traffic${pad(p)}.html`);
/** Pretty URL pushed into history for traffic page p. */
export const trafficPageUrl = (p: number): string => `/${p === 1 ? "traffic.html" : `traffic${pad(p)}.html`}`;
/** Disk filename of the snippet for traffic page p (uniform, includes page 1). */
export const trafficSnippetFileName = (p: number): string => `traffic${pad(p)}.html`;
/** hx-get URL of the snippet for traffic page p. */
export const trafficSnippetUrl = (p: number): string => `/snips/traffic${pad(p)}.html`;

/** Filename-safe slug for a cam's detail page. Ids are namespaced but ad-hoc; whitelist to [A-Za-z0-9_-]. */
export const trafficSlug = (id: string): string =>
  `t-${id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "")}`;
export const trafficUrl = (slug: string): string => `/${slug}.html`;
export const trafficDetailSnippetUrl = (slug: string): string => `/snips/${slug}.html`;

// The tag cloud is a single, unpaginated page linked from the nav; each tag links to
// its browse page (below). It surfaces how tagging is going across all three sources.
export const tagsPageFileName = "tags.html";
export const tagsSnippetFileName = "tags.html";
export const tagsUrl = "/tags.html";
export const tagsSnippetUrl = "/snips/tags.html";

// Browse-by-tag pages: one paginated, blended gallery per tag (cams + streams +
// traffic). `tagSlug` is filename-safe and `tag-`-prefixed so it can't collide with
// host slugs (hex only), the `t-`/`yt-` pages, or the reserved page names; build.ts
// dedupes two tags that slug identically. Page 1 is `tag-<slug>.html`; later pages
// append `-NNN`. Snippet files share the basename (they live under /snips/).
export const tagSlug = (tag: string): string =>
  tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untagged";
export const tagBrowsePageFileName = (slug: string, p: number): string =>
  p === 1 ? `tag-${slug}.html` : `tag-${slug}-${pad(p)}.html`;
export const tagBrowseSnippetFileName = tagBrowsePageFileName;
export const tagBrowseUrl = (slug: string, p = 1): string => `/${tagBrowsePageFileName(slug, p)}`;
export const tagBrowseSnippetUrl = (slug: string, p = 1): string => `/snips/${tagBrowsePageFileName(slug, p)}`;

// The map is a single, unpaginated page (map.html) reachable from the nav: every
// geolocated camera across all three sources is a dot linking to its detail page.
export const mapPageFileName = "map.html";
export const mapSnippetFileName = "map.html";
export const mapUrl = "/map.html";
export const mapSnippetUrl = "/snips/map.html";

// Tips is a single, static standalone page linked from the nav. Its body is baked
// from tips.md once (see src/tips.ts); the build just emits it like tags/map.
export const tipsPageFileName = "tips.html";
export const tipsSnippetFileName = "tips.html";
export const tipsUrl = "/tips.html";
export const tipsSnippetUrl = "/snips/tips.html";

// Fingerprints is a single, unpaginated standalone page linked from the nav: a
// make/model/count breakdown of every fingerprinted camera (see fingerprint.ts),
// emitted like tags/map/tips.
export const fingerprintsPageFileName = "fingerprints.html";
export const fingerprintsSnippetFileName = "fingerprints.html";
export const fingerprintsUrl = "/fingerprints.html";
export const fingerprintsSnippetUrl = "/snips/fingerprints.html";

// Import is a DEV-ONLY view. `bun dev` bakes it (build.ts) and adds an "import"
// nav button (renderShell, gated on `dev`); a production `bun bake` emits none of
// it. The nav button hx-gets import.html into <main>, where the type buttons swap
// per-type form fragments (import-<type>.html) into #import-form.
export const importPageFileName = "import.html";
export const importSnippetFileName = "import.html";
export const importUrl = "/import.html";
export const importSnippetUrl = "/snips/import.html";
/** Disk filename / hx-get URL of a per-type import form fragment (dev-only snippet). */
export const importFormSnippetFileName = (type: string): string => `import-${type}.html`;
export const importFormSnippetUrl = (type: string): string => `/snips/import-${type}.html`;

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
	// The boundary shortcuts — leading `1 …` / trailing `… total` — carry `.pager-ends`
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

/** Numbered pager for the index gallery. */
export function renderPager(cur: number, total: number): string {
	return renderPagerWith(cur, total, pageUrl, snippetUrl);
}

/** Numbered pager for the YouTube streams gallery. */
export function renderStreamsPager(cur: number, total: number): string {
	return renderPagerWith(cur, total, streamsPageUrl, streamsSnippetUrl);
}

/** Numbered pager for the traffic gallery. */
export function renderTrafficPager(cur: number, total: number): string {
	return renderPagerWith(cur, total, trafficPageUrl, trafficSnippetUrl);
}

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

	return [
		`<a class="card" href="${hostUrl(host.slug)}" hx-get="${hostSnippetUrl(host.slug)}" hx-push-url="${hostUrl(host.slug)}"${devAttrs}>`,
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
 * Inner-<main> for the homepage (index.html): a curated landing page with a cams
 * section and a streams section, each showing up to four cards — the featured pins
 * first, then the newest (build.ts assembles the ordering). Reuses the gallery
 * cards verbatim; a "more" link jumps to the full paginated gallery. An empty
 * section is dropped, and if both are empty the galleries' "nothing yet" note shows.
 */
export function renderHomeMain(cams: Host[], streams: YtStream[], traffic: TrafficCam[], opts: RenderOpts = {}): string {
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
		parts.push(section("cams", cards, pageUrl(1), snippetUrl(1), "all cams"));
	}
	if (streams.length) {
		const cards = streams.map((s) => indentBlock(renderYtCard(s, opts), 1)).join("\n");
		parts.push(section("streams", cards, streamsPageUrl(1), streamsSnippetUrl(1), "all streams"));
	}
	if (traffic.length) {
		const cards = traffic.map((c) => indentBlock(renderTrafficCard(c, opts), 1)).join("\n");
		parts.push(section("traffic", cards, trafficPageUrl(1), trafficSnippetUrl(1), "all traffic"));
	}
	if (parts.length === 0) {
		return `<p class="empty">Nothing to feature yet. Run <code>bun run scrape</code>, <code>bun run youtube</code>, or <code>bun run traffic</code> first.</p>`;
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
			const slug = slugForTag(t);
			return `<a href="${tagBrowseUrl(slug)}" hx-get="${tagBrowseSnippetUrl(slug)}" hx-push-url="${tagBrowseUrl(slug)}">${escapeHtml(t)}</a>`;
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
		`${T(1)}<a class="back" href="${pageUrl(1)}" hx-get="${snippetUrl(1)}" hx-push-url="${pageUrl(1)}">&larr; Back to gallery</a>`,
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
	description: string | null;
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
		description: row.description,
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
	return [
		`<a class="card" href="${ytUrl(stream.slug)}" hx-get="${ytSnippetUrl(stream.slug)}" hx-push-url="${ytUrl(stream.slug)}"${devAttrs}>`,
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
	push("Description", stream.description);
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
		`${T(1)}<a class="back" href="/streams.html" hx-get="${streamsSnippetUrl(1)}" hx-push-url="/streams.html">&larr; Back to streams</a>`,
		`</article>`,
	].join("\n");
}

/**
 * Click-to-load YouTube facade for a stream detail page: the thumbnail with a play
 * overlay, rendered as an <a> to the watch URL so it works with no JS. assets/traffic.js
 * intercepts the click and swaps in a youtube-nocookie iframe — no third-party DOM loads
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

// ── Traffic (Osiris) cams ────────────────────────────────────────────────────────
// A third source with its own flat gallery (one card per cam, like the streams
// gallery). Hybrid rendering: the gallery card shows a baked, same-origin thumbnail
// exactly like the other sources, but the detail page embeds the LIVE feed — an
// auto-refreshing <img> (jpg), a <video> (mp4/hls, hls via the vendored hls.js), or,
// for iframe/external-only cams, just a "view live" link (we never load third-party
// DOM). Every live element degrades to that link on error.

export interface TrafficCam {
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

/** Map a stored traffic row (plus its extracted image URL and tags) into a view model. */
export function toTrafficCam(row: StoredTrafficRow, thumbHref: string, tags: string[] = []): TrafficCam {
	const name = (row.name && row.name.trim()) || row.id;
	return {
		id: row.id,
		slug: trafficSlug(row.id),
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
function trafficLoc(cam: TrafficCam): string {
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
 * One traffic card for the gallery. Same shape as a host/stream card (a CSS-background
 * thumbnail figure with a corner badge, a one-line title, a location subtitle) so all
 * three galleries render identically; here the title is the cam name and the subtitle
 * is its location. A cam with no captured thumbnail (link cams, dead feeds) shows the
 * plain black figure.
 */
export function renderTrafficCard(cam: TrafficCam, opts: RenderOpts = {}): string {
	const loc = escapeHtml(trafficLoc(cam));
	const locLine = loc ? `\n${T(1)}<p class="loc">${loc}</p>` : "";
	const devAttrs = opts.dev ? ` data-kind="feed" data-ref="${escapeHtml(cam.id)}"` : "";
	return [
		`<a class="card" href="${trafficUrl(cam.slug)}" hx-get="${trafficDetailSnippetUrl(cam.slug)}" hx-push-url="${trafficUrl(cam.slug)}"${devAttrs}>`,
		`${T(1)}<figure role="img" aria-label="${escapeHtml(cam.thumbAlt)}" style="background-image:url('${escapeHtml(cam.thumbHref)}')">`,
		`${T(1)}</figure>`,
		`${T(1)}<h2>`,
		`${T(2)}<span class="dn-line dn-name">${escapeHtml(cam.name)}</span>`,
		`${T(1)}</h2>${locLine}`,
		`</a>`,
	].join("\n");
}

/** Inner-<main> content for a traffic gallery page: the card grid plus the pager. */
export function renderTrafficMain(cams: TrafficCam[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (cams.length === 0) {
		return `<p class="empty">No traffic cams stored yet. Run <code>bun run traffic</code> first.</p>`;
	}
	const cards = cams.map((c) => indentBlock(renderTrafficCard(c, opts), 1)).join("\n");
	const pager = renderTrafficPager(page, totalPages);
	return [`<section class="gallery">`, cards, `</section>`, ...(pager ? [pager] : [])].join("\n");
}

/**
 * The live media element for a detail page, chosen by feed kind. The `poster` /
 * initial `src` / background is the baked same-origin thumbnail so there's an instant
 * frame and no broken-image flash; the client (traffic.js) then drives the live feed
 * (cache-busting the jpg <img>, streaming the mjpeg <img>, attaching hls.js to the
 * <video>). `link` cams show just the still; the "View live" button is the way through.
 */
function trafficMedia(cam: TrafficCam): string {
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
			// blocked/dead); traffic.js also swaps src to it on error.
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
 * Inner-<main> content for a traffic cam's detail page: the live media (or a
 * placeholder) with a "View live" button, then a lean metadata table. The button
 * targets the human-facing page when there is one, else the raw feed URL.
 */
export function renderTrafficDetail(cam: TrafficCam, opts: RenderOpts = {}): string {
	const media = trafficMedia(cam);
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
	push("Location", trafficLoc(cam));
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
		`${T(1)}<a class="back" href="/traffic.html" hx-get="${trafficSnippetUrl(1)}" hx-push-url="/traffic.html">&larr; Back to traffic</a>`,
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
		return `<p class="empty">No tags yet. Tag something with <code>bun run tag &lt;cam|stream|traffic&gt; &lt;ref&gt; &lt;tag&gt;</code>, then re-bake.</p>`;
	}
	const logs = tags.map((t) => Math.log(t.count));
	const minLog = Math.min(...logs);
	const span = Math.max(1e-9, Math.max(...logs) - minLog);
	const step = (TAG_MAX_SIZE - TAG_MIN_SIZE) / span;

	const items = tags
		.map((t) => {
			const size = Math.round(TAG_MIN_SIZE + (Math.log(t.count) - minLog) * step);
			const name = escapeHtml(t.tag);
			const slug = slugForTag(t.tag);
			const title = `${t.count} ${t.count === 1 ? "entry" : "entries"} tagged ${name}`;
			return `<li><a style="font-size: ${size}%" title="${title}" href="${tagBrowseUrl(slug)}" hx-get="${tagBrowseSnippetUrl(slug)}" hx-push-url="${tagBrowseUrl(slug)}">${name}</a></li>`;
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
// A standalone page (fingerprints.html) with a make → model → count breakdown of every
// fingerprinted camera, built from the `product` field (see fingerprint.ts). Read-only:
// no links, no per-product pages, just a tally that visualizes fingerprinting coverage.
// Makes group via a rowspan cell; the catch-all "Unidentified"/"Other" makes sink last.

/**
 * Inner-<main> content for the fingerprints page: the make/model/count table, or an
 * empty-state note when nothing is fingerprinted. `groups` come pre-sorted from
 * productBreakdown. Every make and model is escaped (models can echo attacker-influenced
 * banner text).
 */
export function renderFingerprintsMain(groups: ProductGroup[]): string {
	if (groups.length === 0) {
		return `<p class="empty">No camera fingerprints yet. Run <code>bun run fingerprint --apply</code>, then re-bake.</p>`;
	}
	const totalCams = groups.reduce((n, g) => n + g.total, 0);
	const fmt = (n: number) => n.toLocaleString();

	const body = groups
		.map((g) => {
			return g.models
				.map((m, i) => {
					const model = m.model === "—" ? `<span class="bd-none">—</span>` : escapeHtml(m.model);
					const cells = [`${T(2)}<td class="bd-model">${model}</td>`, `${T(2)}<td class="bd-count">${fmt(m.count)}</td>`];
					// The make cell spans all of its models and carries the make subtotal.
					const makeCell =
						i === 0
							? `${T(2)}<th scope="rowgroup" rowspan="${g.models.length}" class="bd-make">${escapeHtml(g.make)}<span class="bd-total">${fmt(g.total)}</span></th>\n`
							: "";
					return `${T(1)}<tr>\n${makeCell}${cells.join("\n")}\n${T(1)}</tr>`;
				})
				.join("\n");
		})
		.join("\n");

	return [
		`<section class="breakdown">`,
		`${T(1)}<h2>Device fingerprints</h2>`,
		`${T(1)}<p class="bd-sub">${fmt(totalCams)} cameras across ${groups.length} makes, identified from Shodan banners and feed URLs.</p>`,
		`${T(1)}<table class="bd-table">`,
		`${T(2)}<thead><tr><th scope="col">Make</th><th scope="col">Model</th><th scope="col" class="bd-count">Cameras</th></tr></thead>`,
		`${T(2)}<tbody>`,
		indentBlock(body, 2),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		`</section>`,
	].join("\n");
}

// ── Tag browse pages ─────────────────────────────────────────────────────────────
// One paginated page per tag, a blended gallery of every entity carrying it: cams,
// then streams, then traffic (each kind newest-first, from build.ts). Reuses the same
// card renderers as the galleries, so a tag page looks like any other gallery. Real
// <a>/hx-get links throughout, so browsing works with no JS (only tagging is JS-only).

/** One entity on a tag browse page, tagged with its kind so the right card renderer is used. */
export type TagItem =
	| { kind: "cam"; host: Host }
	| { kind: "stream"; stream: YtStream }
	| { kind: "feed"; cam: TrafficCam };

/** Render one browse-page card, dispatching on the item's kind. */
function renderTagCard(item: TagItem, opts: RenderOpts = {}): string {
	switch (item.kind) {
		case "cam":
			return renderHostCard(item.host, opts);
		case "stream":
			return renderYtCard(item.stream, opts);
		case "feed":
			return renderTrafficCard(item.cam, opts);
	}
}

/** Numbered pager for a tag browse page (URL builders closed over the tag's slug). */
export function renderTagPager(cur: number, total: number, slug: string): string {
	return renderPagerWith(
		cur,
		total,
		(p) => tagBrowseUrl(slug, p),
		(p) => tagBrowseSnippetUrl(slug, p),
	);
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
		`<a class="back" href="${tagsUrl}" hx-get="${tagsSnippetUrl}" hx-push-url="${tagsUrl}">&larr; All tags</a>`,
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
		return `<p class="empty">No geolocated cameras yet. Scrape cams, add traffic, or assign stream coordinates with <code>bun run geo</code>, then re-bake.</p>`;
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

/**
 * The Tips page: a static article (cam-hunting guide) whose body is pre-converted
 * from tips.md into TIPS_HTML (src/tips.ts). No dynamic data — the same string is
 * the full page's <main> and its htmx snippet. Headings carry GitHub-style anchor
 * ids so the in-page table-of-contents links resolve.
 */
export function renderTipsMain(): string {
	return [`<section class="tips">`, indentBlock(TIPS_HTML.trim(), 1), `</section>`].join("\n");
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

// ── Page shell + CSS ─────────────────────────────────────────────────────────

const CSS = `:root {
	/* palette */
	--depths:   #0f1117;
	--abyss:    #161925;
	--poseidon: #114b5f;
	--ocean:    #1c7293;
	--mist:     #c6dabf;
	--fog:      #8a94a6;
	--sand:     #d4d6b6;
	--ice:      #b3dcde;

	/* theme */
	--bg:      var(--depths);
	--surface: var(--abyss);
	--text:    var(--mist);
	--muted:   var(--fog);
	--accent:  var(--ocean);
	--border:  var(--poseidon);
	--land:    #1b2333;
	--coast:   #2b3a52;
	--dot:     #6cc6e6;
	--dot-hi:  #f2c14e;
	--warn:    #e0533f;
	--font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
	--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

	/* metrics */
	--gap:    clamp(1rem, 2vw, 1.5rem);
}

@media (prefers-color-scheme: light) {
	:root {
		--bg:      #f4f6f8;
		--surface: #ffffff;
		--text:    #1a2230;
		--muted:   #5b6472;
		--accent:  #0d3b4a;
		--border:  #d3dbe3;
		--land:    #dfe6ee;
		--coast:   #b9c4d0;
		--dot:     #12667f;
		--dot-hi:  #c0392b;
		--warn:    #c0392b;
	}
}
#favicon {
	fill: var(--depths);
}
@media (prefers-color-scheme: dark) {
	#favicon {
		fill: var(--sand);
	}
}

html,
body {
	height: 100%;
	background: var(--bg);
	color: var(--text);
	font-family: var(--font-family);
	font-size: 13px;
	line-height: 1.6;

	*,
	*::before,
	*::after {
		box-sizing: border-box;
		margin: 0;
		padding: 0;
	}
}

a {
	color: var(--accent);
	text-decoration: none;

	&:hover,
	&:focus-visible {
		background: var(--accent);
		color: var(--ice);
		text-decoration: none;
		outline: none;
	}
}


body > header {
	display: flex;
	flex-flow: row wrap;
	align-items: baseline;
	gap: 0.75rem 1.5rem;
	padding: var(--gap);

	a {
		color: inherit;
		text-decoration: none;
	}

	.nav {
		display: flex;
		flex-flow: row wrap;
		gap: 1rem;
		align-items: center;

		a {
			color: var(--ice);
			&:hover {
				color: var(--sand);
			}
			& .front {
				padding: 8px;
			}
		}

		@media (max-width: 480px) {
			flex-basis: 100%;
			justify-content: space-between;
			gap: unset;

			a .front {
				padding: 6px 10px;
				font-size: 1.1rem;
			}
		}
	}
}

h1 {
	font-size: 2rem;
	font-weight: 600;
	letter-spacing: 0.02em;
	line-height: 1em;

	@media (max-width: 480px) {
		font-size: 1.9rem;
	}
}

h1 > em {
	line-height: 1em;
}

.brand {
	display: flex;
	flex-flow: column nowrap;
	align-self: center;
}

.count {
	display: flex;
	flex-flow: column nowrap;
	color: var(--muted);
	font-variant-numeric: tabular-nums;
	line-height: 1.23em;
	align-self: flex-start;
	align-items: self-end;
	flex-grow: 1;
	font-size: 11px;
	& strong {
		color: var(--ice);
		font-weight: 600;
		font-size: 10px;
	}

	@media (max-width: 735px) {
		header & {
			display: none;
		}
	}
}

main {
	padding: var(--gap);
	padding-top: 0px;
}

.empty {
	color: var(--muted);
	font-size: 1rem;
}

.gallery {
	display: flex;
	flex-flow: row wrap;
	align-items: stretch;
	gap: var(--gap);
}

.card {
	display: flex;
	flex-flow: column nowrap;
	gap: 0.5rem;
	flex: 1 1 22rem;
	min-width: 0;
	max-width: 32rem;
	padding: 1rem;
	background: var(--surface);
	border: 1px solid var(--border);
	color: inherit;
	text-decoration: none;
	transition: border-color 0.15s ease, transform 0.15s ease;

	&:hover,
	&:focus-visible {
		border-color: var(--accent);
		background: var(--surface);
		transform: translateY(-2px);
		outline: none;
	}

	& figure {
		position: relative;
		overflow: hidden;
		background: #000;
		aspect-ratio: 4 / 3;
		background-size: cover;
		background-position: center;
	}

	& h2 {
		font-size: 1.05rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	& .dn-line,
	& .dn-sub {
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	& .dn-sub {
		min-height: 1lh;
	}

	& .loc {
		color: var(--muted);
	}

	& .badge {
		position: absolute;
		right: 0.5rem;
		bottom: 0.5rem;
		padding: 0.1rem 0.5rem;
		background: var(--accent);
		color: #fff;
		font-size: 0.85em;
	}
}

.pager {
	display: flex;
	flex-flow: row wrap;
	justify-content: center;
	align-items: center;
	gap: 0.5rem;
	padding-top: var(--gap);
	font-variant-numeric: tabular-nums;

	& .btn {
		align-self: center;
	}

	& .btn .front {
		min-width: 2.2rem;
		padding: 0.3rem 0.6rem;
		font-size: 1rem;
	}

	& .gap {
		padding: 0 0.25rem;
		color: var(--muted);
	}

	@media (max-width: 480px) {
		& .pager-ends {
			display: none;
		}
	}
}

.host {
	border-top: 1px solid var(--accent);
	padding-top: 10px;
	display: flex;
	flex-flow: column nowrap;
	gap: var(--gap);

	& > h2 {
		font-size: clamp(1.1rem, 3vw, 1.6rem);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
}

.dn-name  { color: var(--sand); }
.dn-ip    { color: var(--mist); }
.dn-ports { color: var(--ice); }

.shots {
	display: flex;
	flex-flow: row wrap;
	gap: var(--gap);
}

.shot {
	display: flex;
	flex-flow: column nowrap;
	gap: 0.5rem;

	& img {
		display: block;
		width: auto;
		height: auto;
		background: #000;
	}

	& figcaption {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
}

.btn {
	--btn-face: var(--accent);
	--btn-edge: color-mix(in srgb, var(--btn-face) 70%, #000);
	--btn-edge-dark: color-mix(in srgb, var(--btn-face) 45%, #000);
	align-self: flex-start;
	position: relative;
	border: none;
	background: transparent;
	padding: 0;
	text-decoration: none;
	cursor: pointer;
	outline-offset: 4px;
	transition: filter 250ms;
	font-family: inherit;

	& .shadow {
		display: block;
		position: absolute;
		inset: 0;
		background: hsl(0deg 0% 0% / 0.25);
		will-change: transform;
		transform: translateY(2px);
		transition: transform 600ms cubic-bezier(0.3, 0.7, 0.4, 1);
	}

	& .edge {
		display: block;
		position: absolute;
		inset: 0;
		background: linear-gradient(
			to left,
			var(--btn-edge-dark) 0%,
			var(--btn-edge) 8%,
			var(--btn-edge) 92%,
			var(--btn-edge-dark) 100%
		);
	}

	& .front {
		display: block;
		position: relative;
		padding: 12px 24px;
		font-size: 1.25rem;
		line-height: 1.6;
		text-align: center;
		color: #efefef;
		background: var(--btn-face);
		will-change: transform;
		transform: translateY(-4px);
		transition: transform 600ms cubic-bezier(0.3, 0.7, 0.4, 1);
	}

	&:not(:disabled):hover {
		filter: brightness(110%);
	}

	&:not(:disabled):hover .front {
		transform: translateY(-6px);
		transition: transform 250ms cubic-bezier(0.3, 0.7, 0.4, 1.5);
	}

	&:not(:disabled):active .front {
		transform: translateY(-2px);
		transition: transform 34ms;
	}

	&:not(:disabled):hover .shadow {
		transform: translateY(4px);
		transition: transform 250ms cubic-bezier(0.3, 0.7, 0.4, 1.5);
	}

	&:not(:disabled):active .shadow {
		transform: translateY(1px);
		transition: transform 34ms;
	}

	&:focus:not(:focus-visible) {
		outline: none;
	}
}

.btn:disabled {
	--btn-face: var(--muted);
	cursor: not-allowed;
	transform: translateY(1px);

	& .front {
		color: #000;
	}
}

.meta {
	width: 100%;
	max-width: 40rem;
	border-collapse: collapse;

	& th,
	& td {
		text-align: left;
		vertical-align: top;
		padding: 0.25rem 0;
		overflow-wrap: anywhere;
	}

	& th {
		width: 1%;
		white-space: nowrap;
		padding-right: 1.5rem;
		color: var(--accent);
		font-weight: 500;
	}
}

.tips {
	max-width: 48rem;

	& h2,
	& h3,
	& h4,
	& h5 {
		line-height: 1.25;
		scroll-margin-top: 1rem;
	}

	& h2 {
		margin-bottom: 1rem;
		padding-bottom: 0.35rem;
		font-size: clamp(1.5rem, 4vw, 2rem);
		color: var(--text);
		border-bottom: 1px solid var(--border);
	}

	& h3 {
		margin-top: 2.5rem;
		padding-bottom: 0.3rem;
		font-size: clamp(1.2rem, 3vw, 1.5rem);
		color: var(--accent);
		border-bottom: 1px solid var(--border);
	}

	& h4 {
		margin-top: 1.75rem;
		font-size: clamp(1.05rem, 2.5vw, 1.2rem);
		color: var(--text);
	}

	& h5 {
		margin-top: 1.25rem;
		font-size: 1rem;
		color: var(--accent);
	}

	& p {
		margin: 0.75rem 0;
	}

	& ul,
	& ol {
		margin: 0.75rem 0;
		padding-left: 1.5rem;

		& ul {
			margin: 0.25rem 0;
		}
	}

	& li {
		margin: 0.3rem 0;
	}

	& code {
		padding: 0.1em 0.35em;
		font-family: var(--font-mono);
		font-size: 0.9em;
		color: var(--fog);
		background: var(--surface);
		border-radius: 4px;
		overflow-wrap: anywhere;
	}

	& hr {
		margin: 2.5rem 0;
		border: none;
		border-top: 1px solid var(--border);
	}
}

.tips blockquote {
	margin: 1.25rem 0;
	padding: 0.6rem 1rem;
	color: var(--muted);
	border-left: 3px solid var(--border);

	& > :first-child {
		margin-top: 0;
	}
}

.tips .admonition {
	color: var(--text);
	border-left-width: 4px;

	& .admonition-label {
		margin: 0 0 0.35rem;
		font-size: 0.8em;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	&.caution {
		border-left-color: var(--warn);

		& .admonition-label {
			color: var(--warn);
		}
	}

	&.tip {
		border-left-color: var(--dot);

		& .admonition-label {
			color: var(--dot);
		}
	}
}

.tips .table-wrap {
	margin: 1.25rem 0;
	overflow-x: auto;
}

.tips table {
	width: 100%;
	border-collapse: collapse;

	& th,
	& td {
		padding: 0.4rem 0.7rem;
		text-align: left;
		vertical-align: top;
		border: 1px solid var(--border);
	}

	& thead th {
		color: var(--accent);
		font-weight: 600;
		white-space: nowrap;
		background: var(--surface);
	}
}

.back {
	align-self: flex-start;
	color: var(--accent);
	text-decoration: none;

	&:hover,
	&:focus-visible {
		text-decoration: underline;
	}
}

body > footer {
	display: none;
	@media (max-width: 735px) {
		display: flex;
		flex-flow: row wrap;
		align-items: baseline;
		gap: 0.75rem 1.5rem;
		padding: var(--gap);
		border-top: 1px solid var(--border);
	}
}

.badge.live {
	background: #c0392b;
}

.badge.upcoming {
	background: var(--poseidon);
}

.shot video {
	display: block;
	width: auto;
	height: auto;
	max-width: 100%;
	background: #000;
}

.live-img {
	display: block;
	max-width: 100%;
	background: #000 center / contain no-repeat;
}

.yt-facade {
	position: relative;
	display: block;
	width: 40rem;
	max-width: 100%;
	aspect-ratio: 16 / 9;
	background-color: #000;
	background-position: center;
	background-size: cover;
	background-repeat: no-repeat;
	cursor: pointer;
}

.yt-facade .yt-play {
	position: absolute;
	inset: 0;
	margin: auto;
	width: 4rem;
	height: 4rem;
	border: 2px solid #fff;
	border-radius: 50%;
	background: rgb(0 0 0 / 0.55);
}

.yt-facade .yt-play::before {
	content: "";
	position: absolute;
	inset: 0;
	margin: auto;
	width: 0;
	height: 0;
	border-style: solid;
	border-width: 0.7rem 0 0.7rem 1.15rem;
	border-color: transparent transparent transparent #fff;
	transform: translateX(0.15rem);
}

.yt-facade:hover .yt-play,
.yt-facade:focus-visible .yt-play {
	background: var(--accent);
}

.yt-embed {
	display: block;
	width: 40rem;
	max-width: 100%;
	aspect-ratio: 16 / 9;
	border: 0;
	background: #000;
}

.siblings {
	display: flex;
	flex-flow: column nowrap;
	gap: var(--gap);

	& > h3 {
		font-size: 1.1rem;
		font-weight: 600;
		color: var(--accent);
	}
}

.noshot {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20rem;
	max-width: 100%;
	aspect-ratio: 4 / 3;
	background: #000;
	color: var(--muted);
}

.tagcloud {
	border-top: 1px solid var(--accent);
	padding-top: 10px;
}

.tags {
	display: flex;
	flex-flow: row wrap;
	align-items: baseline;
	gap: 0.4rem 1.1rem;
	list-style: none;
	line-height: 1.3;

	& a {
		color: var(--ice);
		font-variant-numeric: tabular-nums;
		text-decoration: none;
		transition: color 0.15s;
	}

	& a:hover,
	& a:focus-visible {
		color: var(--accent);
		text-decoration: underline;
	}
}

.breakdown {
	border-top: 1px solid var(--accent);
	padding-top: 10px;

	& h2 {
		margin-bottom: 0.2rem;
		font-size: clamp(1.1rem, 3vw, 1.5rem);
		font-weight: 600;
		color: var(--accent);
	}

	& .bd-sub {
		margin-bottom: 1.1rem;
		color: var(--muted);
		font-size: 0.9rem;
	}
}

.bd-table {
	width: 100%;
	max-width: 40rem;
	border-collapse: collapse;
	font-variant-numeric: tabular-nums;

	& th,
	& td {
		text-align: left;
		vertical-align: top;
		padding: 0.3rem 0.9rem 0.3rem 0;
		border-bottom: 1px solid var(--border);
	}

	& thead th {
		color: var(--accent);
		font-weight: 600;
		white-space: nowrap;
	}

	& .bd-count {
		text-align: right;
		padding-right: 0;
		white-space: nowrap;
	}

	& .bd-make {
		white-space: nowrap;
		color: var(--text);
		font-weight: 600;
		border-bottom: 2px solid var(--accent);
	}

	& .bd-total {
		display: block;
		color: var(--muted);
		font-weight: 400;
		font-size: 0.8rem;
	}

	& .bd-model {
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	& .bd-none {
		color: var(--border);
	}
}

.home {
	display: flex;
	flex-flow: column nowrap;
	gap: var(--gap);
	margin-bottom: calc(var(--gap) * 1.5);

	& .section-title {
		font-size: clamp(1.1rem, 3vw, 1.5rem);
		font-weight: 600;
		color: var(--accent);
		border-bottom: 1px solid var(--border);
		padding-bottom: 0.35rem;
	}

	& .more {
		align-self: flex-start;
		color: var(--accent);
		text-decoration: none;
	}

	& .more:hover,
	& .more:focus-visible {
		text-decoration: underline;
	}
}

.mapwrap {
	border-top: 1px solid var(--accent);
	padding-top: 10px;
	display: flex;
	flex-flow: column nowrap;
	gap: 0.75rem;
}

.maphint {
	color: var(--muted);
}

.worldmap {
	display: block;
	width: 100%;
	height: auto;
	max-height: 82vh;
	background: var(--bg);
	touch-action: none;
	cursor: grab;

	&:active {
		cursor: grabbing;
	}

	& .land path {
		fill: var(--land);
		stroke: var(--coast);
		stroke-width: 0.5;
		vector-effect: non-scaling-stroke;
	}

	& .dots circle {
		fill: var(--dot);
		fill-opacity: 0.6;
		transition: fill 0.1s ease;
	}

	& .dots a:hover circle,
	& .dots a:focus-visible circle {
		fill: var(--dot-hi);
		fill-opacity: 1;
	}
}`;

/** Site-wide stat block under the h1, identical on every page. */
export interface SiteStats {
	/** Combined cams+streams+traffic total, pre-formatted (toLocaleString). */
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
	const stat = (label: string, value: string): string =>
		`<span>${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`;
	const ghStat= (label: string, value: string, href: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" target="_blank">${escapeHtml(value)}</a></strong></span>`;
	const statLink = (label: string, value: string, href: string, snip: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">${escapeHtml(value)}</a></strong></span>`;
	const counts = [
		statLink("cameras discovered", stats.discovered, fingerprintsUrl, fingerprintsSnippetUrl),
		ghStat("updated", stats.updated, "https://github.com/xero/w3b.cam/deployments"),
		stat("fresh scrapes every", stats.interval),
	].join("");
	// Nav links are real .btn links — larger siblings of the pager buttons: the same
	// three stacked layers (shadow / edge / labelled front), plus the header-only
	// hx-target/hx-swap so they swap <main> like the in-main links.
	const navLink = (href: string, snip: string, label: string, classes:string = ''): string =>
		[
			`<a class="btn ${classes}" href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">`,
			btnLayers(label),
			`</a>`,
		].join("\n");
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
		`${T(2)}<style>`,
		indentBlock(CSS, 2),
		`${T(2)}</style>`,
		...(dev ? [`${T(2)}<link rel="stylesheet" href="/__dev/dev.css" />`] : []),
		`${T(1)}</head>`,
		`${T(1)}<body>`,
		`${T(2)}<header>`,
		`${T(3)}<div class="brand">`,
		`${T(4)}<h1><a href="${homeUrl}" hx-get="${homeSnippetUrl}" ${navAttrs} hx-push-url="${homeUrl}">${escapeHtml(TITLE)}</a></h1>`,
		`${T(4)}<em>internet voyeurism</em>`,
		`${T(3)}</div>`,
		`${T(3)}<nav class="nav">`,
		indentBlock(navLink(pageUrl(1), snippetUrl(1), "cams"), 4),
		indentBlock(navLink("/streams.html", streamsSnippetUrl(1), "streams"), 4),
		indentBlock(navLink("/traffic.html", trafficSnippetUrl(1), "traffic"), 4),
		indentBlock(navLink(tagsUrl, tagsSnippetUrl, "tags"), 4),
		indentBlock(navLink(mapUrl, mapSnippetUrl, "map"), 4),
		indentBlock(navLink(tipsUrl, tipsSnippetUrl, "tips"), 4),
		// Dev-only: a nav entry that hx-gets the import view into <main> (see renderImportMain).
		...(dev ? [indentBlock(navLink(importUrl, importSnippetUrl, "import", "dev"), 4)] : []),
		`${T(3)}</nav>`,
		`${T(3)}<p class="count">${counts}</p>`,
		`${T(2)}</header>`,
		`${T(2)}<main hx-target:inherited="main" hx-swap:inherited="innerHTML show:top">`,
		indentBlock(mainInner, 3),
		`${T(2)}</main>`,
		`${T(2)}<footer>`,
		`${T(3)}<p class="count">${counts}</p>`,
		`${T(2)}</footer>`,
		`${T(2)}<script src="/htmx.min.js"></script>`,
		// Live-feed client on every page (tiny): drives traffic detail feeds and must be
		// present however you arrive, including htmx swaps whose snippets carry no script.
		// It loads hls.min.js on demand only when an HLS cam is actually viewed.
		`${T(2)}<script src="/traffic.js" defer></script>`,
		// Map client (tiny): drag-to-pan / wheel-to-zoom for the SVG world map. Like
		// traffic.js it loads on every page and no-ops when no map is present.
		`${T(2)}<script src="/map.js" defer></script>`,
		...(dev ? [`${T(2)}<script src="/__dev/dev.js"></script>`] : []),
		`${T(1)}</body>`,
		"</html>",
		"",
	].join("\n");
}
