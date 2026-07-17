import { T, indentBlock, type RenderOpts } from "./primitives.ts";
import { liveImg, facadeWrap } from "./live-facade.ts";
import { renderFeedPager, btnLayers } from "./pager.ts";
import { galleryBody, metaRow, pushMetaRow, detailArticle, renderTagLinks } from "./shared.ts";
import { escapeHtml } from "../../core/util.ts";
import type { StoredFeedRow, FeedKind } from "../../core/types.ts";
import { FEEDS, HOME, feedRoute, feedSlug, snipUrlOf, urlOf } from "../urls.ts";

// ── Feed (Osiris) cams ────────────────────────────────────────────────────────
// A third source with its own flat gallery (one card per cam, like the streams
// gallery). Hybrid rendering: the gallery card shows a baked, same-origin thumbnail
// exactly like the other sources. The detail page CAN show the LIVE feed — an
// auto-refreshing <img> (jpg), an MJPEG <img>, or a <video> (mp4/hls, hls via the
// vendored hls.js) — but never loads it unprompted: every auto-playing kind renders as a
// click-to-load `.facade` (the baked still with a play overlay), exactly like the YouTube
// streams. The live element sits inert inside a <template> until the user clicks, so no
// cross-origin request fires on page load. `link` cams (unembeddable) show just the still;
// the "View live" link is the way through. Every live element degrades to that link on error.

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
	return galleryBody(cards, pager);
}

/**
 * The live media element for a detail page, chosen by feed kind. The `poster` /
 * initial `src` / background is the baked same-origin thumbnail so there's an instant
 * frame and no broken-image flash; the client (feeds.js) then drives the live feed
 * (cache-busting the jpg <img>, streaming the mjpeg <img>, attaching hls.js to the
 * <video>). `link` cams show just the still; the "View live" button is the way through.
 *
 * This is NOT emitted into the live DOM directly for the auto-playing kinds — feedFacade
 * wraps it in an inert <template> behind a play button so nothing loads until the user
 * opts in. Only `link` (a plain same-origin still) is rendered as-is.
 */
function feedMedia(cam: FeedCam): string {
	const alt = escapeHtml(cam.thumbAlt);
	const poster = cam.thumbHref ? ` poster="${escapeHtml(cam.thumbHref)}"` : "";
	switch (cam.feedKind) {
		case "jpg":
			// Auto-refreshing snapshot: the baked still is the initial src (instant frame),
			// data-refresh is the endpoint feeds.js cache-busts on a timer.
			return liveImg("jpg", cam.liveUrl, cam.thumbHref, cam.thumbAlt);
		case "mjpeg":
			// A multipart <img> plays a Motion JPEG stream natively, no JS needed. The baked
			// still rides as the background (instant frame, and the fallback if the stream is
			// blocked/dead); feeds.js also swaps src to it on error.
			return liveImg("mjpeg", cam.liveUrl, cam.thumbHref, cam.thumbAlt);
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
 * Click-to-load wrapper for the auto-playing feed kinds (jpg/mjpeg/mp4/hls): the baked
 * still with a play overlay (a `.facade`, shared with the YouTube streams), with the real
 * live element held inert inside a <template>. Nothing loads until the user clicks —
 * feeds.js clones the template in place of the facade and starts it. The facade is an <a>
 * to the view-live URL, so with no JS the click just opens the feed (same as the button
 * below). `link` cams have no live feed to opt into, so they render as the plain still.
 */
function feedFacade(cam: FeedCam, liveHref: string): string {
	const media = feedMedia(cam);
	if (cam.feedKind === "link" || media.trim() === "") return media;
	return facadeWrap({ liveHref, thumbHref: cam.thumbHref, ariaName: cam.name, media });
}

/**
 * Inner-<main> content for a feed cam's detail page: the live media (or a
 * placeholder) with a "View live" button, then a lean metadata table. The button
 * targets the human-facing page when there is one, else the raw feed URL.
 */
export function renderFeedDetail(cam: FeedCam, opts: RenderOpts = {}): string {
	const liveHref = cam.externalUrl ?? cam.liveUrl;
	const media = feedFacade(cam, liveHref);
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
	pushMetaRow(rows, "Source", cam.source);
	pushMetaRow(rows, "Fingerprint", cam.product);
	pushMetaRow(rows, "Location", feedLoc(cam));
	if (cam.lat != null && cam.lng != null) pushMetaRow(rows, "Coordinates", `${cam.lat}, ${cam.lng}`);
	pushMetaRow(rows, "Type", feedKindLabel(cam.feedKind));
	if (cam.tags.length) rows.push(metaRow("Tags", renderTagLinks(cam.tags, opts.slugForTag)));

	return detailArticle({
		headingHtml: escapeHtml(cam.name),
		shotsInner: figure,
		rows,
		backRoute: FEEDS,
		backLabel: "feeds",
	});
}

/**
 * Combined detail page for a super-feature event group: every correlated feed's live view
 * stacked together (each labeled with its source + kind), then one merged metadata table.
 * Each single-value field shows the first member that has it (the pacast stream carries less
 * metadata than the 511PA jpg, so this fills gaps); Source, Feeds, and Tags show the union.
 * The first feed is the primary — its name is the page heading. Reuses feedMedia + the
 * view-live button block that renderFeedDetail uses.
 */
export function renderEventDetail(feeds: FeedCam[], opts: RenderOpts = {}): string {
	const primary = feeds[0]!;
	const figures = feeds
		.map((cam) => {
			const liveHref = cam.externalUrl ?? cam.liveUrl;
			const devAttrs = opts.dev ? ` data-kind="feed" data-ref="${escapeHtml(cam.id)}"` : "";
			const cap = [cam.source, feedKindLabel(cam.feedKind)].filter((s): s is string => !!s && s.trim() !== "").map((s) => escapeHtml(s)).join(" &middot; ");
			return [
				`${T(1)}<figure class="shot"${devAttrs}>`,
				feedFacade(cam, liveHref),
				`${T(2)}<a class="btn" href="${escapeHtml(liveHref)}" target="_blank" rel="noopener noreferrer">`,
				indentBlock(btnLayers("View live"), 2),
				`${T(2)}</a>`,
				cap ? `${T(2)}<figcaption>${cap}</figcaption>` : "",
				`${T(1)}</figure>`,
			].filter((s) => s !== "").join("\n");
		})
		.join("\n");

	const rows: string[] = [];
	const sources = [...new Set(feeds.map((c) => c.source).filter((s): s is string => !!s && s.trim() !== ""))];
	if (sources.length) rows.push(metaRow("Source", escapeHtml(sources.join(", "))));
	pushMetaRow(rows, "Fingerprint", feeds.map((c) => c.product).find((p) => p != null && p.trim() !== ""));
	pushMetaRow(rows, "Location", feeds.map((c) => feedLoc(c)).find((l) => l.trim() !== ""));
	const geoCam = feeds.find((c) => c.lat != null && c.lng != null);
	if (geoCam) pushMetaRow(rows, "Coordinates", `${geoCam.lat}, ${geoCam.lng}`);
	rows.push(metaRow("Feeds", escapeHtml(feeds.map((c) => feedKindLabel(c.feedKind)).join(", "))));
	const allTags = [...new Set(feeds.flatMap((c) => c.tags))].sort();
	if (allTags.length) rows.push(metaRow("Tags", renderTagLinks(allTags, opts.slugForTag)));

	return detailArticle({
		headingHtml: escapeHtml(primary.name),
		shotsInner: figures,
		rows,
		backRoute: HOME,
		backLabel: "home",
	});
}
