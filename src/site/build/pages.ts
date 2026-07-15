// Page emitter: writes each route's full document (index.html) and its co-located snippet
// (index.snippet.html) from one `mainInner` string, so the two can never drift.

import { OUT_DIR, SITE_URL } from "../../core/config.ts";
import { renderShell, type SiteStats } from "../render.ts";
import { diskOf, snipDiskOf, urlOf } from "../urls.ts";

/** One Unix-seconds stamp per build, appended as ?x=<EPOCH> to OG image URLs so social
 *  scrapers re-fetch an updated screenshot instead of serving a stale cached preview. */
const EPOCH = Math.floor(Date.now() / 1000);

/**
 * Write one page: the full document to OUT_DIR/<route>/index.html and its co-located
 * snippet to OUT_DIR/<route>/index.snippet.html (root route -> OUT_DIR/index.html and
 * index.snippet.html). Both come from the same `mainInner`, so they never drift.
 *
 * `opts.thumb` is a page's site-relative OG preview image (e.g. "/img/<hash>.jpg"), made
 * absolute + cache-busted here; every caller resolves it to a real image (see the pickers
 * in build()), so the social card always has a picture.
 */
export async function writePage(route: string, mainInner: string, title: string, stats: SiteStats, opts: { dev?: boolean; thumb?: string } = {}): Promise<void> {
	const ogImage = opts.thumb ? `${SITE_URL}${opts.thumb}?x=${EPOCH}` : "";
	const ogUrl = `${SITE_URL}${urlOf(route)}`;
	await Bun.write(`${OUT_DIR}/${diskOf(route)}`, renderShell({ title, stats, mainInner, dev: opts.dev, ogImage, ogUrl }));
	await Bun.write(`${OUT_DIR}/${snipDiskOf(route)}`, `${mainInner}\n`);
}
