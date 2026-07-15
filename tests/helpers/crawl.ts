// Node-safe (imported from Playwright specs, which run under Node): pull internal link
// targets out of a baked HTML string. The build emits root-relative URLs only, so we
// collect href="/..." and hx-get="/..." and let the caller verify each resolves.

export interface InternalLinks {
	hrefs: string[];
	hxGets: string[];
}

export function extractInternalLinks(html: string): InternalLinks {
	const hrefs = new Set<string>();
	const hxGets = new Set<string>();
	for (const m of html.matchAll(/\bhref="(\/[^"]*)"/g)) hrefs.add(m[1]!);
	for (const m of html.matchAll(/\bhx-get="(\/[^"]*)"/g)) hxGets.add(m[1]!);
	return { hrefs: [...hrefs], hxGets: [...hxGets] };
}

/** Extract the src of every <img> whose src is root-relative (e.g. /img/<hash>.png). */
export function extractImgSrcs(html: string): string[] {
	const srcs = new Set<string>();
	for (const m of html.matchAll(/<img\b[^>]*\bsrc="(\/[^"]*)"/g)) srcs.add(m[1]!);
	return [...srcs];
}

/** Extract url("/...") targets from inline style attributes (card figure backgrounds). */
export function extractBgUrls(html: string): string[] {
	const urls = new Set<string>();
	for (const m of html.matchAll(/url\((?:&quot;|["']?)(\/[^"')]+?)(?:&quot;|["']?)\)/g)) urls.add(m[1]!);
	return [...urls];
}
