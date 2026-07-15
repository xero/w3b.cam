import { T, indentBlock, type RenderOpts } from "./primitives.ts";
import { renderPagerWith, renderGalleryPager, renderVendorPager, btnLayers } from "./pager.ts";
import { galleryBody } from "./shared.ts";
import { renderHostCard, type Host } from "./host.ts";
import { renderYtCard, type YtStream } from "./stream.ts";
import { renderFeedCard, type FeedCam } from "./feed.ts";
import { escapeHtml } from "../../core/util.ts";
import type { ProductGroup } from "../../core/types.ts";
import { FINGERPRINTS, TAGS, snipUrlOf, tagPage, tagRoute, urlOf, vendorRoute } from "../urls.ts";

// ── Tags cloud ─────────────────────────────────────────────────────────────────
// A cloud of every tag across all three sources (the unified `tags` table), each
// sized by how many entities carry it. Each tag links to its browse page; the count
// rides along in a title tooltip. Sizing is a LOG map from count to a font-size
// percentage (not linear): counts are a long tail (a few tags on hundreds of
// entities, most on a handful), so a linear map crushes the tail against the minimum
// size. ln() spreads the low/mid range so the cloud actually varies.

interface TagCount {
	tag: string;
	count: number;
	/** Derived auto-tag (see autotags.ts): sized on the hand-tag scale but may overshoot TAG_MAX_SIZE. */
	auto?: boolean;
}

/** Smallest / largest font-size (percent) a tag maps to; the count range spans these. */
const TAG_MIN_SIZE = 100;
const TAG_MAX_SIZE = 320;
/** Auto-tags dwarf hand tags (mjpeg ~5k vs the biggest hand tag ~500), so let them grow a bit past TAG_MAX_SIZE, up to this ceiling. */
const AUTO_TAG_MAX_SIZE = 440;

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
	// Scale from the hand tags only, so the existing cloud keeps its sizing when auto-tags
	// (whose counts dwarf hand tags) are mixed in. Auto-tags ride the same scale but clamp to
	// the higher AUTO_TAG_MAX_SIZE, so a genuinely-huge one reads a bit larger than the biggest
	// hand tag while smaller auto-tags still size like any normal tag below the max.
	const scaleTags = tags.filter((t) => !t.auto);
	const logs = (scaleTags.length ? scaleTags : tags).map((t) => Math.log(t.count));
	const minLog = Math.min(...logs);
	const span = Math.max(1e-9, Math.max(...logs) - minLog);
	const step = (TAG_MAX_SIZE - TAG_MIN_SIZE) / span;

	const items = tags
		.map((t) => {
			const raw = TAG_MIN_SIZE + (Math.log(t.count) - minLog) * step;
			const size = Math.round(Math.min(t.auto ? AUTO_TAG_MAX_SIZE : TAG_MAX_SIZE, Math.max(TAG_MIN_SIZE, raw)));
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
		return `<p class="empty">No camera fingerprints yet. Ingest some cameras (they're fingerprinted on import), then re-bake.</p>`;
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
		`${T(1)}<p class="bd-sub">${fmt(totalCams)} cameras identified across ${groups.length} makes, identified via banners and feed URLs.</p>`,
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
function renderTagPager(cur: number, total: number, slug: string): string {
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
	return galleryBody(cards, pager, {
		after: `<a class="back" href="${urlOf(TAGS)}" hx-get="${snipUrlOf(TAGS)}" hx-push-url="${urlOf(TAGS)}">&larr; All tags</a>`,
	});
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
	return galleryBody(cards, pager);
}

/** Inner-<main> for a per-vendor fingerprint gallery: a heading, blended cards, the vendor pager, and a back link. */
export function renderVendorMain(vendor: string, items: TagItem[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	const back = `<a class="back" href="${urlOf(FINGERPRINTS)}" hx-get="${snipUrlOf(FINGERPRINTS)}" hx-push-url="${urlOf(FINGERPRINTS)}">&larr; All fingerprints</a>`;
	if (items.length === 0) {
		return [`<p class="empty">No <strong>${escapeHtml(vendor)}</strong> cameras are visible right now.</p>`, back].join("\n");
	}
	const cards = items.map((it) => indentBlock(renderTagCard(it, opts), 1)).join("\n");
	const pager = renderVendorPager(page, totalPages, vendor);
	return galleryBody(cards, pager, {
		before: `<h2 class="vendor-title">${escapeHtml(vendor)} cameras</h2>`,
		after: back,
	});
}
