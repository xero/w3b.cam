import { T, indentBlock, type RenderOpts } from "./primitives.ts";
import { renderStreamsPager, btnLayers } from "./pager.ts";
import { galleryBody, metaRow, pushMetaRow, detailArticle, renderTagLinks } from "./shared.ts";
import { escapeHtml } from "../../core/util.ts";
import type { StoredYtRow } from "../../core/types.ts";
import { STREAMS, snipUrlOf, streamRoute, urlOf, ytSlug } from "../urls.ts";

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
	return galleryBody(cards, pager);
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
	pushMetaRow(rows, "Channel", stream.channelTitle);
	pushMetaRow(rows, "Status", liveStatusText(stream.liveContent));
	pushMetaRow(rows, "Published", stream.publishedAt);
	pushMetaRow(rows, "Scheduled", stream.scheduledStart);
	pushMetaRow(rows, "Started", stream.actualStart);
	if (stream.tags.length) rows.push(metaRow("Tags", renderTagLinks(stream.tags, opts.slugForTag)));

	return detailArticle({
		headingHtml: escapeHtml(stream.label),
		shotsInner: figure,
		rows,
		extra: renderSiblings(stream, siblings, opts),
		backRoute: STREAMS,
		backLabel: "streams",
	});
}

/**
 * Click-to-load YouTube facade for a stream detail page: the thumbnail with a play
 * overlay, rendered as an <a> to the watch URL so it works with no JS. assets/feeds.js
 * intercepts the click (any `.facade`) and, since this one carries `data-yt`, swaps in a
 * youtube-nocookie iframe — no third-party DOM loads until the user opts in. The "Watch on
 * YouTube" button beneath it stays as the fallback. Shares the `.facade` look and click
 * plumbing with the feed facades (feed.ts), which instead opt-in to a live feed element.
 */
function ytFacade(stream: YtStream): string {
	const bg = stream.thumbHref ? ` style="background-image:url('${escapeHtml(stream.thumbHref)}')"` : "";
	return [
		`${T(2)}<a class="facade" href="${escapeHtml(stream.url)}" data-yt="${escapeHtml(stream.videoId)}" aria-label="Play ${escapeHtml(stream.label)}"${bg}>`,
		`${T(3)}<span class="play" aria-hidden="true"></span>`,
		`${T(2)}</a>`,
	].join("\n");
}
