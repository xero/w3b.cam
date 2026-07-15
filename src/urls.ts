// The URL / route layer. One place that decides every site path, so render.ts (links)
// and build.ts (disk writes) can never disagree. Extracted from render.ts in Phase 2
// when the site moved from flat `foo.html` files to clean folder URLs.
//
// A "route" is the clean path with no leading or trailing slash: "" (the homepage),
// "gallery/1", "hosts/194.94.76.131", "fingerprints/axis/2". Every page derives its
// three artifacts from its route uniformly:
//   - full page on disk : <route>/index.html          (root: index.html)
//   - snippet on disk    : <route>/index.snippet.html  (root: index.snippet.html)
//   - pretty URL         : /<route>                     (root: /)
//   - snippet URL        : /<route>/index.snippet.html  (root: /index.snippet.html)
// The snippet is co-located beside its page (no separate /snips tree): htmx hx-gets the
// .snippet.html and swaps it into <main>, while the pretty URL is the no-JS href and the
// pushed history entry. Pretty URLs carry no trailing slash (GitHub Pages 301s /foo to
// /foo/, and src/serve.ts resolves /foo to /foo/index.html locally).

/** Full-page disk path for a route, relative to OUT_DIR. */
export const diskOf = (route: string): string => (route === "" ? "index.html" : `${route}/index.html`);
/** Snippet disk path for a route, relative to OUT_DIR (co-located beside the page). */
export const snipDiskOf = (route: string): string => (route === "" ? "index.snippet.html" : `${route}/index.snippet.html`);
/** Pretty URL for a route (the no-JS href and the pushed history entry). */
export const urlOf = (route: string): string => (route === "" ? "/" : `/${route}`);
/** Snippet URL for a route (the hx-get target). Always the disk path served from root. */
export const snipUrlOf = (route: string): string => `/${snipDiskOf(route)}`;

// ── Static landing routes ─────────────────────────────────────────────────────
// The bare route a nav button / "more" link / back link targets. Paginated sections
// also write page 1's content to this bare route (see build.ts), so it mirrors "/1".

export const HOME = "";
export const GALLERY = "gallery";
export const HOSTS = "hosts";
export const FEEDS = "feeds";
export const STREAMS = "streams";
export const TAGS = "tags";
export const FINGERPRINTS = "fingerprints";
export const MAP = "map";
export const TIPS = "tips";
export const IMPORT = "import";
export const EVENT = "event";

// ── Paginated routes (numbered; the pager links these, page 1 included) ─────────

export const galleryPage = (p: number): string => `${GALLERY}/${p}`;
export const hostsPage = (p: number): string => `${HOSTS}/${p}`;
export const feedsPage = (p: number): string => `${FEEDS}/${p}`;
export const streamsPage = (p: number): string => `${STREAMS}/${p}`;
/** Bare per-tag landing (linked from the cloud; mirrors page 1). */
export const tagRoute = (slug: string): string => `${TAGS}/${slug}`;
/** Numbered per-tag page (the pager links these). */
export const tagPage = (slug: string, p: number): string => `${TAGS}/${slug}/${p}`;
/** Bare per-vendor fingerprint gallery landing (mirrors page 1). */
export const vendorRoute = (vendor: string): string => `${FINGERPRINTS}/${vendor}`;
/** Numbered per-vendor page (the pager links these). */
export const vendorPage = (vendor: string, p: number): string => `${FINGERPRINTS}/${vendor}/${p}`;

// ── Detail routes ───────────────────────────────────────────────────────────────

export const hostRoute = (slug: string): string => `${HOSTS}/${slug}`;
export const feedRoute = (slug: string): string => `${FEEDS}/${slug}`;
export const streamRoute = (slug: string): string => `${STREAMS}/${slug}`;
/** Combined page for a super-feature event group (both correlated feeds on one page). */
export const eventRoute = (key: string): string => `${EVENT}/${eventSlug(key)}`;

// ── Slugs (the folder name that identifies one detail page) ─────────────────────

/**
 * Folder name for a host, keyed on its IP. IPv4 keeps its dots so the URL reads and
 * copies like the real IP (`hosts/194.94.76.131`); IPv6 colons fold to hyphens since a
 * colon in a path segment is awkward. Whitelist to hex/dot/colon first so anything
 * hostile (`/`, `..`) is dropped and the result is always traversal-safe.
 */
export function hostSlug(ip: string): string {
	return (
		ip
			.toLowerCase()
			.replace(/[^0-9a-f.:]+/g, "")
			.replace(/:/g, "-")
			.replace(/^[.-]+|[.-]+$/g, "") || "host"
	);
}

/**
 * Folder name for a feed. Feed ids are already `[A-Za-z0-9_.-]` (verified), and the
 * `mjpeg-<ip>` subset carries a real dotted IP, so strip that prefix to let those read
 * like an IP (`feeds/38.79.156.188`). The whitelist is defense-in-depth (traversal).
 */
export function feedSlug(id: string): string {
	const base = id.startsWith("mjpeg-") ? id.slice(6) : id;
	return base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "feed";
}

/** Folder name for a video's detail page. Ids are already `[A-Za-z0-9_-]`; this is defensive. */
export const ytSlug = (id: string): string => `yt-${id.replace(/[^A-Za-z0-9_-]+/g, "")}`;

/** Folder name for a super-feature event page, from its (hand-entered) key. Whitelist for traversal safety. */
export const eventSlug = (key: string): string =>
	key.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "event";

/**
 * Folder name for a tag. Lowercased and hyphenated; build.ts dedupes two tags that slug
 * identically with a numeric suffix (see the tagSlugs map there).
 */
export const tagSlug = (tag: string): string =>
	tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untagged";

// ── Import (DEV-ONLY) per-type form fragments ───────────────────────────────────
// Snippet-only (no full page): the import view's type buttons hx-get one of these into
// #import-form. They nest under import/ beside the import page's own index.snippet.html.

export const importFormSnippetDisk = (type: string): string => `${IMPORT}/${type}.snippet.html`;
export const importFormSnippetUrl = (type: string): string => `/${importFormSnippetDisk(type)}`;
