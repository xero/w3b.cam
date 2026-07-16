import { T, indentBlock } from "./primitives.ts";
import { escapeHtml } from "../../core/util.ts";
import {
	GALLERY, HOME, HOSTS, FEEDS, STREAMS, FINGERPRINTS, TAGS, MAP, TIPS, IMPORT,
	snipUrlOf, urlOf,
} from "../urls.ts";

export const TITLE = "w3b.cam";
const THEME_COLOR = "#667eea";
/** Site-wide copy for <meta name="description"> and the OG/Twitter description cards. */
const SITE_DESCRIPTION = "internet voyeurism, cam hunters anonymous";

// ── Page shell ───────────────────────────────────────────────────────────────

/** Site-wide stat block under the h1, identical on every page. */
export interface SiteStats {
	/** Combined cams+streams+feed total, pre-formatted (toLocaleString). */
	discovered: string;
	/** Build time, e.g. "2026-07-09 @ 10:59" (UTC, no tz label). */
	updated: string;
	/** Refresh cadence, e.g. "6 hrs". */
	interval: string;
}

interface ShellOpts {
	/** <title> for the full page (host pages differ, for bookmarks/deep links). */
	title: string;
	/** Site-wide stat block shown under the h1; identical on every page. */
	stats: SiteStats;
	/** Inner-<main> content, the exact same string written as the snippet. */
	mainInner: string;
	/** Dev mode: link /__dev/dev.css and load /__dev/dev.js (both served by src/server/dev.ts). */
	dev?: boolean;
	/** Absolute, cache-busted OG/Twitter preview image URL; "" omits the image tags. */
	ogImage?: string;
	/** Absolute canonical page URL for og:url; "" omits the tag. */
	ogUrl?: string;
}

/** Wrap inner-<main> content in the full HTML document. */
export function renderShell({ title, stats, mainInner, dev = false, ogImage = "", ogUrl = "" }: ShellOpts): string {
	// Header links (brand + nav + the discovered-count link) live outside <main>, so they
	// can't inherit its hx-target:inherited / hx-swap:inherited. Without a resolvable
	// target htmx falls back to a full-page navigation on the href, which loads the whole
	// document (its own <main> included) and appends it. Set both explicitly so these
	// links swap the snippet into <main>, exactly like the in-main links.
	const navAttrs = 'hx-target="main" hx-swap="innerHTML show:top"';
	const ghStat= (label: string, value: string, href: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" target="_blank">${escapeHtml(value)}</a></strong></span>`;
	const statLink = (label: string, value: string, href: string, snip: string): string =>
		`<span>${escapeHtml(label)} <strong><a href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">${escapeHtml(value)}</a></strong></span>`;
	const counts = [
		statLink("cameras discovered", stats.discovered, urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS)),
		ghStat("updated", stats.updated, "https://github.com/xero/w3b.cam/deployments"),
		ghStat("fresh scrapes every", stats.interval, "https://github.com/xero/w3b.cam/blob/main/.github/workflows/scrape.yml#L9"),
	].join("");
	const navLink = (href: string, snip: string, label: string, classes:string = ''): string => [
		`<a class="${classes}" href="${href}" hx-get="${snip}" ${navAttrs} hx-push-url="${href}">`,
		`<svg alt="${label}" aria-label="${label}"><use href="/icons.svg#${label}"></use></svg>`,
		`</a>`,
	].join("");
	return [
		"<!DOCTYPE html>",
		'<html lang="en">',
		`${T(1)}<head>`,
		`${T(2)}<meta charset="UTF-8" />`,
		`${T(2)}<meta name="viewport" content="width=device-width, initial-scale=1" />`,
		`${T(2)}<meta name="theme-color" content="${THEME_COLOR}" />`,
		`${T(2)}<title>${escapeHtml(title)}</title>`,
		`${T(2)}<meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}" />`,
		`${T(2)}<meta property="og:title" content="${escapeHtml(title)}" />`,
		`${T(2)}<meta property="og:type" content="website" />`,
		`${T(2)}<meta property="og:site_name" content="${escapeHtml(TITLE)}" />`,
		`${T(2)}<meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}" />`,
		...(ogUrl ? [`${T(2)}<meta property="og:url" content="${escapeHtml(ogUrl)}" />`] : []),
		...(ogImage ? [`${T(2)}<meta property="og:image" content="${escapeHtml(ogImage)}" />`] : []),
		`${T(2)}<meta name="twitter:card" content="summary_large_image" />`,
		`${T(2)}<meta name="twitter:title" content="${escapeHtml(title)}" />`,
		`${T(2)}<meta name="twitter:description" content="${escapeHtml(SITE_DESCRIPTION)}" />`,
		...(ogImage ? [`${T(2)}<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`] : []),
		`${T(2)}<link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />`,
		`${T(2)}<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
		`${T(2)}<link rel="shortcut icon" href="/favicon.ico" />`,
		`${T(2)}<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`,
		`${T(2)}<meta name="apple-mobile-web-app-title" content="${escapeHtml(TITLE)}" />`,
		`${T(2)}<link rel="manifest" href="/site.webmanifest" />`,
		`${T(2)}<link rel="alternate" type="application/rss+xml" title="${escapeHtml(TITLE)} live feed" href="/rss.xml" />`,
		`${T(2)}<link rel="alternate" type="application/atom+xml" title="${escapeHtml(TITLE)} live feed" href="/atom.xml" />`,
		`${T(2)}<link rel="stylesheet" href="/style.css" />`,
		// CRT overlay styles for the opt-in "cctv" theme (assets/theme.js mounts the layers).
		// Always linked so the effect is ready instantly on switch; classes are inert until then.
		`${T(2)}<link rel="stylesheet" href="/crt.css" />`,
		...(dev ? [`${T(2)}<link rel="stylesheet" href="/__dev/dev.css" />`] : []),
		// Restore a manually-picked theme (assets/theme.js) before first paint so the saved
		// choice doesn't flash the OS preference first. Runs in <head> before <body> exists,
		// so the class lands on <html>; the allow-list keeps arbitrary storage out of it.
		`${T(2)}<script>try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark"||t==="cctv")document.documentElement.classList.add(t);}catch(e){}</script>`,
		`${T(1)}</head>`,
		`${T(1)}<body>`,
		`${T(2)}<header>`,
		`${T(3)}<div class="brand">`,
		`${T(4)}<h1><a href="${urlOf(HOME)}" hx-get="${snipUrlOf(HOME)}" ${navAttrs} hx-push-url="${urlOf(HOME)}">${escapeHtml(TITLE)}</a></h1>`,
		`${T(4)}<em>internet voyeurism</em>`,
		`${T(3)}</div>`,
		`${T(3)}<nav class="nav">`,
		indentBlock(navLink(urlOf(GALLERY), snipUrlOf(GALLERY), "gallery"), 4),
		indentBlock(navLink(urlOf(HOSTS), snipUrlOf(HOSTS), "hosts"), 4),
		indentBlock(navLink(urlOf(FEEDS), snipUrlOf(FEEDS), "feeds"), 4),
		indentBlock(navLink(urlOf(STREAMS), snipUrlOf(STREAMS), "streams"), 4),
		indentBlock(navLink(urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS), "fingerprints"), 4),
		indentBlock(navLink(urlOf(TAGS), snipUrlOf(TAGS), "tags"), 4),
		indentBlock(navLink(urlOf(MAP), snipUrlOf(MAP), "map"), 4),
		indentBlock(navLink(urlOf(TIPS), snipUrlOf(TIPS), "tips"), 4),
		...(dev ? [indentBlock(navLink(urlOf(IMPORT), snipUrlOf(IMPORT), "import", "dev"), 4)] : []),
		`${T(3)}</nav>`,
		`${T(2)}</header>`,
		`${T(2)}<main hx-target:inherited="main" hx-swap:inherited="innerHTML show:top">`,
		indentBlock(mainInner, 3),
		`${T(2)}</main>`,
		`${T(2)}<footer>`,
		`${T(3)}<p id="syndication">`,
		`${T(4)}<a href="/atom.xml"><svg alt="atom feed" aria-label="atom feed"><use href="/icons.svg#atom"></use></svg></a>`,
		`${T(4)}<a href="/rss.xml"><svg alt="rss feed" aria-label="rss feed"><use href="/icons.svg#rss"></use></svg></a>`,
		`${T(3)}</p>`,
		`${T(3)}<cite><a href="https://3xi.club" target="_blank">3xi.club</a> project by <a href="https://x-e.ro" target="_blank">xero</a></cite>`,
		`${T(3)}<p class="count">${counts}</p>`,
		`${T(2)}</footer>`,
		`${T(2)}<script src="/htmx.min.js"></script>`,
		// Shared init/teardown plumbing for feeds.js + map.js; must load before them.
		`${T(2)}<script src="/live-lifecycle.js" defer></script>`,
		// Live-feed client on every page (tiny): drives feed detail feeds and must be
		// present however you arrive, including htmx swaps whose snippets carry no script.
		// It loads hls.min.js on demand only when an HLS cam is actually viewed.
		`${T(2)}<script src="/feeds.js" defer></script>`,
		// Map client (tiny): drag-to-pan / wheel-to-zoom for the SVG world map. Like
		// feeds.js it loads on every page and no-ops when no map is present.
		`${T(2)}<script src="/map.js" defer></script>`,
		// Precomputed CRT layer spec (window.__CRT) for the cctv theme, baked by the build.
		// Deferred before theme.js so the global is set when the picker mounts the overlay.
		`${T(2)}<script src="/crt-config.js" defer></script>`,
		// Theme picker (tiny): writes the opt-in style selector into the header and
		// toggles a class on <html>. No dependency on live-lifecycle; header/<html>
		// aren't swapped by htmx, so a one-shot init suffices.
		`${T(2)}<script src="/theme.js" defer></script>`,
		...(dev ? [`${T(2)}<script src="/__dev/dev.js"></script>`] : []),
		`${T(1)}</body>`,
		"</html>",
		"",
	].join("\n");
}

