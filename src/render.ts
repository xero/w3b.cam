// Pure rendering: DB rows -> HTML strings. No IO here (build.ts does the writing
// and image extraction). Every banner-derived string is attacker-controlled, so it
// is HTML-escaped before interpolation, exactly as the original single-page build did.

import { displayParts, escapeHtml, pickDisplayName } from "./util.ts";
import type { StoredRow } from "./types.ts";

export const TITLE = "w3b.cam";
export const THEME_COLOR = "#0f1117";

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
// Root-relative (served at the domain root by src/serve.ts). Page 1 lives at
// index.html and pushes "/"; snippets are uniformly named so every pager link
// computes its hx-get with no special case.

const pad = (p: number): string => String(p).padStart(3, "0");

/** Disk filename of full index page p (page 1 is index.html, no page001.html). */
export const pageFileName = (p: number): string => (p === 1 ? "index.html" : `page${pad(p)}.html`);
/** Pretty URL pushed into history for index page p. */
export const pageUrl = (p: number): string => (p === 1 ? "/" : `/page${pad(p)}.html`);
/** Disk filename of the snippet for index page p (uniform, includes page 1). */
export const snippetFileName = (p: number): string => `page${pad(p)}.html`;
/** hx-get URL of the snippet for index page p. */
export const snippetUrl = (p: number): string => `/snips/page${pad(p)}.html`;

export const hostUrl = (slug: string): string => `/${slug}.html`;
export const hostSnippetUrl = (slug: string): string => `/snips/${slug}.html`;

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
	org: string | null;
	isp: string | null;
	asn: string | null;
	product: string | null;
	hostnames: string[];
	domains: string[];
	labels: string[];
	httpTitle: string | null;
	// Free-form tags applied per-IP (see ip_tags), shared across all of a host's ports.
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
	return (candidate.timestamp ?? "") > (current.timestamp ?? "");
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
 * screenshot file. `tagsByIp` supplies per-IP tags (see loadIpTags); an IP absent
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
			timestamp: r.timestamp,
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
		built.push({ host, ts: rep.timestamp ?? "" });
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
function pageLink(p: number, label: string): string {
	return [
		`<a class="btn" href="${pageUrl(p)}" hx-get="${snippetUrl(p)}" hx-push-url="${pageUrl(p)}">`,
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

/** Numbered pager (`« ‹ 1 … 4 [5] 6 … 77 › »`). Empty when there is only one page. */
export function renderPager(cur: number, total: number): string {
	if (total <= 1) return "";
	const parts: string[] = [];
	const first = cur > 1;
	const last = cur < total;

	parts.push(first ? pageLink(1, "&laquo;") : pageDisabled("&laquo;"));
	parts.push(first ? pageLink(cur - 1, "&lsaquo;") : pageDisabled("&lsaquo;"));
	for (const p of pageWindow(cur, total)) {
		if (p === "…") parts.push(`<span class="gap">&hellip;</span>`);
		else if (p === cur) parts.push(pageCurrent(p));
		else parts.push(pageLink(p, String(p)));
	}
	parts.push(last ? pageLink(cur + 1, "&rsaquo;") : pageDisabled("&rsaquo;"));
	parts.push(last ? pageLink(total, "&raquo;") : pageDisabled("&raquo;"));

	const items = parts.map((p) => indentBlock(p, 1)).join("\n");
	return [`<nav class="pager" aria-label="Pagination">`, items, `</nav>`].join("\n");
}

// ── Index cards ──────────────────────────────────────────────────────────────

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
export function renderHostCard(host: Host): string {
	const badge =
		host.count > 1
			? `\n${T(2)}<span class="badge">${host.count} screenshots</span>`
			: "";
	const loc = [host.city, host.country_name]
		.filter((v): v is string => !!v && v.trim() !== "")
		.map(escapeHtml)
		.join(", ");
	const locLine = loc ? `\n${T(1)}<p class="loc">${loc}</p>` : "";

	return [
		`<a class="card" href="${hostUrl(host.slug)}" hx-get="${hostSnippetUrl(host.slug)}" hx-push-url="${hostUrl(host.slug)}">`,
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
export function renderIndexMain(hosts: Host[], page: number, totalPages: number): string {
	if (hosts.length === 0) {
		return `<p class="empty">No cameras stored yet. Run <code>bun run scrape</code> first.</p>`;
	}
	const cards = hosts.map((h) => indentBlock(renderHostCard(h), 1)).join("\n");
	const pager = renderPager(page, totalPages);
	return [
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
	].join("\n");
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

function shotFigure(shot: Shot): string {
	const caption = [
		`Port ${escapeHtml(shot.port)}`,
		shot.product && shot.product.trim() ? escapeHtml(shot.product) : "",
		shot.timestamp ? `<time datetime="${escapeHtml(shot.timestamp)}">${escapeHtml(shot.timestamp)}</time>` : "",
	]
		.filter((s) => s !== "")
		.join(" &middot; ");
	return [
		`${T(1)}<figure class="shot">`,
		`${T(2)}<img src="${escapeHtml(shot.imgHref)}" alt="${escapeHtml(shot.imgAlt)}" loading="lazy" />`,
		`${T(2)}<figcaption>${caption}</figcaption>`,
		`${T(2)}<a class="btn" href="${escapeHtml(shot.liveHref)}" target="_blank" rel="noopener noreferrer">`,
		indentBlock(btnLayers("View live"), 2),
		`${T(2)}</a>`,
		`${T(1)}</figure>`,
	].join("\n");
}

/** Inner-<main> content for a host page: screenshots up top, one shared metadata table. */
export function renderHostMain(host: Host): string {
	const shots = host.shots.map(shotFigure).join("\n");

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
	if (host.tags.length) rows.push(metaRow("Tags", escapeHtml(host.tags.join(", "))));

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
		`${T(1)}<a class="back" href="/" hx-get="${snippetUrl(1)}" hx-push-url="/">&larr; Back to gallery</a>`,
		`</article>`,
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
	--font-family: system-ui, -apple-system, "Segoe UI", sans-serif;

	/* metrics */
	--gap:    clamp(1rem, 2vw, 1.5rem);
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

body > header {
	display: flex;
	flex-flow: row wrap;
	align-items: baseline;
	gap: 0.75rem 1.5rem;
	padding: var(--gap);
}

body > header a {
	color: inherit;
	text-decoration: none;
}

h1 {
	font-size: clamp(1.3rem, 4vw, 2rem);
	font-weight: 600;
	letter-spacing: 0.02em;
	line-height: 1em;
}

h1 > em {
	line-height: 1em;
}

.brand {
	display: flex;
	flex-flow: column nowrap;
}

.count {
	display: flex;
	flex-flow: column nowrap;
	color: var(--muted);
	font-variant-numeric: tabular-nums;
	line-height: 1.23em;
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
	padding: var(--gap);
	color: var(--muted);
	border-top: 1px solid var(--border);
}

@media (prefers-color-scheme: light) {
	:root {
		--bg:      #f4f6f8;
		--surface: #ffffff;
		--text:    #1a2230;
		--muted:   #5b6472;
		--accent:  #0d3b4a;
		--border:  #d3dbe3;
	}
}`;

export interface ShellOpts {
	/** <title> for the full page (host pages differ, for bookmarks/deep links). */
	title: string;
	/** Count line shown under the h1; constant across pages (not updated on swap). */
	headerText: string;
	/** Inner-<main> content, the exact same string written as the snippet. */
	mainInner: string;
}

/** Wrap inner-<main> content in the full HTML document. */
export function renderShell({ title, headerText, mainInner }: ShellOpts): string {
	const counts = headerText
		.split(" · ")
		.map((c) => `<span>${escapeHtml(c.trim())}</span>`)
		.join("");
	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		"\t<head>",
		'\t\t<meta charset="UTF-8" />',
		'\t\t<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`\t\t<meta name="theme-color" content="${THEME_COLOR}" />`,
		`\t\t<title>${escapeHtml(title)}</title>`,
		"\t\t<style>",
		indentBlock(CSS, 2),
		"\t\t</style>",
		"\t</head>",
		"\t<body>",
		"\t\t<header>",
		`\t\t\t<div class="brand">`,
		`\t\t\t\t<h1><a href="/" hx-get="${snippetUrl(1)}" hx-push-url="/">${escapeHtml(TITLE)}</a></h1>`,
		`\t\t\t\t<em>internet voyeurism</em>`,
		`\t\t\t</div>`,
		`\t\t\t<p class="count">${counts}</p>`,
		"\t\t</header>",
		'\t\t<main hx-target:inherited="main" hx-swap:inherited="innerHTML show:top">',
		indentBlock(mainInner, 3),
		"\t\t</main>",
		'\t\t<script src="/htmx.min.js"></script>',
		"\t</body>",
		"</html>",
		"",
	].join("\n");
}
