import { T, indentBlock } from "./primitives.ts";
import { urlOf, snipUrlOf, hostsPage, galleryPage, streamsPage, feedsPage, vendorPage } from "../urls.ts";

// ── Pagination ───────────────────────────────────────────────────────────────

/** Windowed page set: fixed width of 2·span+5 slots, with "…" filling gaps. */
function pageWindow(cur: number, total: number, span = 2): (number | "…")[] {
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
export function btnLayers(label: string): string {
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
export function renderPagerWith(
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
