import { T, indentBlock } from "./primitives.ts";
import { escapeHtml } from "../../core/util.ts";

// Shared click-to-load facade markup for live media, used by both the feed detail pages
// (feed.ts) and the host detail pages (host.ts). Nothing here loads until the user clicks:
// facadeWrap holds the real element inert inside a <template>, and assets/feeds.js swaps it
// in on click. The markup contract (the .facade/.play classes, the <template class=
// "facade-media">, the live-img data-* attributes) is shared so a change can't drift the two
// renderers apart and break the one client that drives them.

/**
 * The live <img> for a click-to-load feed of kind `jpg` (a snapshot re-fetched on a timer)
 * or `mjpeg` (a multipart stream that plays natively). `thumbHref` is the baked same-origin
 * still: the jpg's initial src (instant frame) and the mjpeg's data-still/background fallback.
 */
export function liveImg(kind: "jpg" | "mjpeg", liveUrl: string, thumbHref: string, alt: string): string {
	const a = escapeHtml(alt);
	if (kind === "jpg") {
		const src = thumbHref ? ` src="${escapeHtml(thumbHref)}"` : "";
		return `${T(2)}<img class="live-img" data-refresh="${escapeHtml(liveUrl)}"${src} alt="${a}" referrerpolicy="no-referrer" />`;
	}
	const still = thumbHref ? ` data-still="${escapeHtml(thumbHref)}"` : "";
	const bg = thumbHref ? ` style="background-image:url('${escapeHtml(thumbHref)}')"` : "";
	return `${T(2)}<img class="live-img" data-mjpeg src="${escapeHtml(liveUrl)}"${still}${bg} alt="${a}" referrerpolicy="no-referrer" />`;
}

/**
 * Wrap a live media element in a click-to-load `.facade`: the baked still as the poster, a
 * play overlay, and the real element (`media`, already indented to a figure child) held inert
 * inside a <template> so no cross-origin request fires until the click. The facade is an <a>
 * to `liveHref`, so with no JS the click just opens the feed (the "View live" button is the
 * same target). Expects to sit as a figure child (media at tab depth 2, like feed.ts/host.ts).
 */
export function facadeWrap(opts: { liveHref: string; thumbHref: string; ariaName: string; media: string }): string {
	const bg = opts.thumbHref ? ` style="background-image:url('${escapeHtml(opts.thumbHref)}')"` : "";
	return [
		`${T(2)}<a class="facade" href="${escapeHtml(opts.liveHref)}" aria-label="Play ${escapeHtml(opts.ariaName)}"${bg}>`,
		`${T(3)}<span class="play" aria-hidden="true"></span>`,
		`${T(3)}<template class="facade-media">`,
		indentBlock(opts.media, 2),
		`${T(3)}</template>`,
		`${T(2)}</a>`,
	].join("\n");
}
