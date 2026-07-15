// Pure syndication rendering: the newest hosts -> RSS 2.0 / Atom 1.0 XML strings.
// No IO here (build.ts stats the image files and writes rss.xml / atom.xml), mirroring
// render.ts. Every host-derived value is attacker-controlled, so it is escaped before
// interpolation. "feed"/FeedCam elsewhere means an Osiris camera feed — unrelated; this
// module is deliberately named "syndication" to avoid that collision.

import { SITE_URL } from "../core/config.ts";
import { hostRoute, urlOf } from "./urls.ts";
import { displayParts, escapeHtml } from "../core/util.ts";
import { T, TITLE, type Host } from "./render.ts";

/** Channel/feed identity shown to readers. */
const FEED_TITLE = `${TITLE} live feed`;
const FEED_DESCRIPTION = "most recently discovered cameras";

/** One syndication entry, resolved from a host (build.ts supplies the enclosure byte length). */
interface FeedItem {
	/** e.g. `160.218.97.98:8080 (o2.cz)` */
	title: string;
	/** Absolute permalink to the host page. */
	link: string;
	/** Stable id; the permalink doubles as it. */
	guid: string;
	/** e.g. `Port 8080 · Bosch VideoJet · 2026-07-07T13:35:33.013014` */
	description: string;
	/** Representative shot's observed_at (raw ISO), used to format the item date. */
	date: string;
	/** Screenshot enclosure; absent when the host has no stored image. */
	image?: { url: string; length: number; type: string };
}

/** Image MIME from a `/img/<hash>.<ext>` href (the ext was already allowlisted by extFromMime). */
const EXT_MIME: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};
function mimeFromHref(href: string): string {
	const ext = href.slice(href.lastIndexOf(".") + 1).toLowerCase();
	return EXT_MIME[ext] ?? "image/jpeg";
}

/**
 * Resolve a host into a feed entry. The representative shot is the one whose image is the
 * card thumbnail (fall back to the first shot); its port, product, and observed_at drive
 * the title, description, and date so all three describe the same screenshot. The enclosure
 * is emitted only when the host has a stored image and its byte length is known.
 */
export function hostToFeedItem(host: Host, enclosureLength: number | null): FeedItem {
	const rep = host.shots.find((s) => host.thumbHref !== "" && s.imgHref === host.thumbHref) ?? host.shots[0];
	const port = rep?.port;
	const { host: ipText, name } = displayParts(host.hostnames, host.domains, host.ip, port !== undefined ? [port] : []);

	const title = `${ipText}${port !== undefined ? `:${port}` : ""}${name ? ` (${name})` : ""}`;
	const link = `${SITE_URL}${urlOf(hostRoute(host.slug))}`;
	const description = [
		port !== undefined ? `Port ${port}` : "",
		rep?.product && rep.product.trim() ? rep.product : "",
		rep?.timestamp ?? "",
	]
		.filter((s) => s !== "")
		.join(" · ");

	const item: FeedItem = { title, link, guid: link, description, date: rep?.timestamp ?? "" };
	if (host.thumbHref !== "" && enclosureLength != null) {
		item.image = { url: `${SITE_URL}${host.thumbHref}`, length: enclosureLength, type: mimeFromHref(host.thumbHref) };
	}
	return item;
}

// ── Date formatting ──────────────────────────────────────────────────────────
// observed_at is a Python isoformat with no timezone and microsecond precision
// (`2026-07-07T13:35:33.013014`). Normalize to a Date (truncate to milliseconds, treat a
// timezone-less value as UTC) so `new Date()` parses it reliably across engines.

function parseObserved(iso: string): Date | null {
	if (!iso) return null;
	let s = iso.trim().replace(/(\.\d{3})\d+/, "$1");
	if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** RFC-822 date for RSS `<pubDate>`, or "" when unparseable. */
function toRfc822(iso: string): string {
	const d = parseObserved(iso);
	return d ? d.toUTCString() : "";
}

/** RFC-3339 date for Atom `<updated>`, or "" when unparseable. */
function toRfc3339(iso: string): string {
	const d = parseObserved(iso);
	return d ? d.toISOString() : "";
}

// ── RSS 2.0 ────────────────────────────────────────────────────────────────────

function rssItem(item: FeedItem): string {
	const lines = [
		`${T(2)}<item>`,
		`${T(3)}<title>${escapeHtml(item.title)}</title>`,
		`${T(3)}<link>${escapeHtml(item.link)}</link>`,
		`${T(3)}<guid isPermaLink="true">${escapeHtml(item.guid)}</guid>`,
		`${T(3)}<description>${escapeHtml(item.description)}</description>`,
	];
	const pub = toRfc822(item.date);
	if (pub) lines.push(`${T(3)}<pubDate>${pub}</pubDate>`);
	if (item.image) {
		lines.push(
			`${T(3)}<enclosure url="${escapeHtml(item.image.url)}" length="${item.image.length}" type="${escapeHtml(item.image.type)}" />`,
		);
	}
	lines.push(`${T(2)}</item>`);
	return lines.join("\n");
}

/** Render the newest items as an RSS 2.0 document (`out/rss.xml`). */
export function renderRss(items: FeedItem[]): string {
	return (
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
			`${T(1)}<channel>`,
			`${T(2)}<title>${escapeHtml(FEED_TITLE)}</title>`,
			`${T(2)}<link>${escapeHtml(SITE_URL)}</link>`,
			`${T(2)}<description>${escapeHtml(FEED_DESCRIPTION)}</description>`,
			`${T(2)}<atom:link href="${escapeHtml(`${SITE_URL}/rss.xml`)}" rel="self" type="application/rss+xml" />`,
			`${T(2)}<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`,
			...items.map(rssItem),
			`${T(1)}</channel>`,
			"</rss>",
		].join("\n") + "\n"
	);
}

// ── Atom 1.0 ────────────────────────────────────────────────────────────────────

function atomEntry(item: FeedItem): string {
	const lines = [
		`${T(1)}<entry>`,
		`${T(2)}<title>${escapeHtml(item.title)}</title>`,
		`${T(2)}<id>${escapeHtml(item.guid)}</id>`,
		`${T(2)}<link href="${escapeHtml(item.link)}" rel="alternate" type="text/html" />`,
		`${T(2)}<updated>${toRfc3339(item.date) || new Date().toISOString()}</updated>`,
		`${T(2)}<summary>${escapeHtml(item.description)}</summary>`,
	];
	if (item.image) {
		lines.push(
			`${T(2)}<link href="${escapeHtml(item.image.url)}" rel="enclosure" type="${escapeHtml(item.image.type)}" length="${item.image.length}" />`,
		);
	}
	lines.push(`${T(1)}</entry>`);
	return lines.join("\n");
}

/** Render the newest items as an Atom 1.0 document (`out/atom.xml`). */
export function renderAtom(items: FeedItem[]): string {
	// items[0] is the newest (hosts arrive newest-first), so the feed's <updated> tracks it.
	const updated = toRfc3339(items[0]?.date ?? "") || new Date().toISOString();
	return (
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<feed xmlns="http://www.w3.org/2005/Atom">',
			`${T(1)}<title>${escapeHtml(FEED_TITLE)}</title>`,
			`${T(1)}<subtitle>${escapeHtml(FEED_DESCRIPTION)}</subtitle>`,
			`${T(1)}<id>${escapeHtml(`${SITE_URL}/atom.xml`)}</id>`,
			`${T(1)}<link href="${escapeHtml(`${SITE_URL}/atom.xml`)}" rel="self" type="application/atom+xml" />`,
			`${T(1)}<link href="${escapeHtml(SITE_URL)}" rel="alternate" type="text/html" />`,
			`${T(1)}<author>`,
			`${T(2)}<name>${escapeHtml(TITLE)}</name>`,
			`${T(1)}</author>`,
			`${T(1)}<updated>${updated}</updated>`,
			...items.map(atomEntry),
			"</feed>",
		].join("\n") + "\n"
	);
}
