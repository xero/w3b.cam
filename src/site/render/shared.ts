import { T, indentBlock } from "./primitives.ts";
import { urlOf, snipUrlOf, tagRoute } from "../urls.ts";
import { escapeHtml } from "../../core/util.ts";

/**
 * The shared paginated-gallery body: a `<section class="gallery">` card grid followed by
 * the pager, with optional markup spliced before (a heading) or after (a back link).
 * Callers build the `cards` string and `pager`; an empty pager is dropped.
 */
export function galleryBody(cards: string, pager: string, opts: { before?: string; after?: string } = {}): string {
	return [
		...(opts.before ? [opts.before] : []),
		`<section class="gallery">`,
		cards,
		`</section>`,
		...(pager ? [pager] : []),
		...(opts.after ? [opts.after] : []),
	].join("\n");
}

export function metaRow(label: string, valueHtml: string): string {
	return [
		`<tr>`,
		`${T(1)}<th scope="row">${escapeHtml(label)}</th>`,
		`${T(1)}<td>${valueHtml}</td>`,
		`</tr>`,
	].join("\n");
}

/** Append a metadata table row when `value` is non-empty (the value is escaped). */
export function pushMetaRow(rows: string[], label: string, value: string | null | undefined): void {
	if (value && String(value).trim() !== "") rows.push(metaRow(label, escapeHtml(value)));
}

/**
 * The shared detail-page shell for host, stream, and feed pages: an <article> with a
 * heading, a `.shots` figure block, one `.meta` table, an optional extra section (stream
 * pages splice in sibling streams here), and a back link. `headingHtml`, `shotsInner`, and
 * `extra` are already-final HTML; `rows` are metaRow() strings.
 */
export function detailArticle(opts: {
	headingHtml: string;
	shotsInner: string;
	rows: string[];
	extra?: string;
	backRoute: string;
	backLabel: string;
}): string {
	return [
		`<article class="host">`,
		`${T(1)}<h2>${opts.headingHtml}</h2>`,
		`${T(1)}<div class="shots">`,
		indentBlock(opts.shotsInner, 1),
		`${T(1)}</div>`,
		`${T(1)}<table class="meta">`,
		`${T(2)}<tbody>`,
		indentBlock(opts.rows.join("\n"), 3),
		`${T(2)}</tbody>`,
		`${T(1)}</table>`,
		...(opts.extra ? [indentBlock(opts.extra, 1)] : []),
		`${T(1)}<a class="back" href="${urlOf(opts.backRoute)}" hx-get="${snipUrlOf(opts.backRoute)}" hx-push-url="${urlOf(opts.backRoute)}">&larr; Back to ${opts.backLabel}</a>`,
		`</article>`,
	].join("\n");
}

/**
 * The comma-joined value for a "Tags" meta row. With `slugForTag` each tag is an
 * anchor to its browse page (real href + hx-get so it works with no JS); without it
 * (a context that has no slug map) tags fall back to plain escaped text. Names are
 * attacker-controlled, so escaped either way.
 */
export function renderTagLinks(tags: string[], slugForTag?: (tag: string) => string): string {
	if (!slugForTag) return escapeHtml(tags.join(", "));
	return tags
		.map((t) => {
			const route = tagRoute(slugForTag(t));
			return `<a href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}">${escapeHtml(t)}</a>`;
		})
		.join(", ");
}
