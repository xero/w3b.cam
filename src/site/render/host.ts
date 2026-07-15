import { T, indentBlock, safeParseArray, liveUrl, type RenderOpts } from "./primitives.ts";
import { renderPager, btnLayers } from "./pager.ts";
import { galleryBody, metaRow, pushMetaRow, detailArticle, renderTagLinks } from "./shared.ts";
import { renderYtCard, type YtStream } from "./stream.ts";
import { renderFeedCard, type FeedCam } from "./feed.ts";
import { displayParts, escapeHtml, pickDisplayName } from "../../core/util.ts";
import type { StoredRow, ProductGroup } from "../../core/types.ts";
import {
	FEEDS, FINGERPRINTS, HOSTS, STREAMS, TAGS,
	hostRoute, hostSlug, snipUrlOf, tagRoute, urlOf, vendorRoute,
} from "../urls.ts";

// ── Grouped model ────────────────────────────────────────────────────────────

interface Shot {
	port: number;
	product: string | null;
	timestamp: string | null;
	imgHref: string;
	imgAlt: string;
	liveHref: string;
}

export interface Host {
	ip: string;
	slug: string;
	displayName: string;
	count: number;
	shots: Shot[];
	thumbHref: string;
	thumbAlt: string;
	thumbPort: number; // cam: port of the shot the card image comes from (dev change-thumbnail hook)
	// shared metadata, coalesced from the most-recent-timestamp row
	country_name: string | null;
	city: string | null;
	region_code: string | null;
	latitude: number | null;
	longitude: number | null;
	org: string | null;
	isp: string | null;
	asn: string | null;
	product: string | null;
	hostnames: string[];
	domains: string[];
	labels: string[];
	httpTitle: string | null;
	// Free-form tags applied per-IP (the `tags` table, kind='cam'), shared across all of a host's ports.
	tags: string[];
}

function jsonPath(raw: string, get: (o: Record<string, unknown>) => unknown): unknown {
	try {
		const o: unknown = JSON.parse(raw);
		return o && typeof o === "object" ? get(o as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function extractHttpTitle(raw: string): string | null {
	const http = jsonPath(raw, (o) => o.http);
	if (http && typeof http === "object" && "title" in http) {
		const t = (http as { title?: unknown }).title;
		return typeof t === "string" && t.trim() ? t : null;
	}
	return null;
}

function extractLabels(raw: string): string[] {
	const ss = jsonPath(raw, (o) => o.screenshot);
	if (ss && typeof ss === "object" && "labels" in ss) {
		const l = (ss as { labels?: unknown }).labels;
		return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
	}
	return [];
}

/**
 * Which of two rows should represent a host on its card. A pinned row
 * (`preferred = 1`, set via `bun run reorder`) wins outright; otherwise the most
 * recent by timestamp wins (ISO strings sort lexically), and a tie keeps
 * `current`, the earlier row in the (…, port) query order, so ties fall to the
 * lowest port. With nothing pinned this is identical to the old newest-wins rule.
 */
function isBetterRep(candidate: StoredRow, current: StoredRow): boolean {
	const cp = candidate.preferred ? 1 : 0;
	const rp = current.preferred ? 1 : 0;
	if (cp !== rp) return cp > rp;
	return (candidate.observed_at ?? "") > (current.observed_at ?? "");
}

/**
 * Collapse rows sharing an IP into host entries, ordered newest-first by each
 * host's representative-row timestamp. The representative row supplies the card
 * thumbnail and shared metadata: it is the row pinned via `reorder`
 * (`preferred = 1`), else the most-recent by timestamp; a pinned host ranks
 * in the gallery by its pinned shot's timestamp. Rows arrive ordered by
 * (country_name, ip_str, port), so a host's ports stay adjacent, shots keep
 * their port order, and hosts sharing a timestamp fall back to that stable
 * country-grouped order. `imgHref` maps a row to the URL of its already-extracted
 * screenshot file. `tagsByIp` supplies per-IP tags (see loadTags); an IP absent
 * from the map has no tags.
 */
export function groupByIp(
	rows: StoredRow[],
	imgHref: (row: StoredRow) => string,
	tagsByIp: Map<string, string[]> = new Map(),
): Host[] {
	const groups = new Map<string, StoredRow[]>();
	for (const r of rows) {
		const g = groups.get(r.ip_str);
		if (g) g.push(r);
		else groups.set(r.ip_str, [r]);
	}

	const usedSlugs = new Set<string>();
	// Pair each host with its representative (most-recent) timestamp so the whole
	// set can be ordered newest-first once every group is built.
	const built: { host: Host; ts: string }[] = [];
	for (const [ip, group] of groups) {
		// Representative row = the pinned row if any, else most recent (see isBetterRep).
		let rep = group[0];
		if (!rep) continue; // unreachable: a group always has >= 1 row
		for (const r of group) {
			if (isBetterRep(r, rep)) rep = r;
		}

		let slug = hostSlug(ip) || "host";
		if (usedSlugs.has(slug)) {
			let n = 2;
			while (usedSlugs.has(`${slug}-${n}`)) n++;
			slug = `${slug}-${n}`;
		}
		usedSlugs.add(slug);

		const shots: Shot[] = group.map((r) => ({
			port: r.port,
			product: r.product,
			timestamp: r.observed_at,
			imgHref: imgHref(r),
			imgAlt: `Screenshot from ${r.ip_str}:${r.port}`,
			liveHref: liveUrl(r.ip_str, r.port),
		}));

		const host: Host = {
			ip,
			slug,
			displayName: pickDisplayName(
				safeParseArray(rep.hostnames),
				safeParseArray(rep.domains),
				ip,
				shots.map((s) => s.port),
			),
			count: shots.length,
			shots,
			thumbHref: imgHref(rep),
			thumbPort: rep.port,
			thumbAlt: `Screenshot from ${ip}`,
			country_name: rep.country_name,
			city: rep.city,
			region_code: rep.region_code,
			latitude: rep.lat,
			longitude: rep.lng,
			org: rep.org,
			isp: rep.isp,
			asn: rep.asn,
			product: rep.product,
			hostnames: safeParseArray(rep.hostnames),
			domains: safeParseArray(rep.domains),
			labels: extractLabels(rep.raw_json),
			httpTitle: extractHttpTitle(rep.raw_json),
			tags: tagsByIp.get(ip) ?? [],
		};
		built.push({ host, ts: rep.observed_at ?? "" });
	}

	// Newest host first. ISO timestamps sort lexically; a missing timestamp ("")
	// sorts last. Array.sort is stable, so hosts sharing a timestamp keep the
	// country-grouped insertion order established above.
	built.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	return built.map((b) => b.host);
}

/**
 * The `ip:ports` half of a host title, tinted. The `:` separator keeps the default
 * text colour; the ip and ports are coloured. Always present (ports may be empty).
 * Every segment is escaped since these values are attacker-controlled. Shared by
 * the gallery cards and the per-host page heading so both tint identically.
 */
function renderHostPort(host: Host): string {
	const { host: ip, ports } = displayParts(
		host.hostnames,
		host.domains,
		host.ip,
		host.shots.map((s) => s.port),
	);
	return (
		`<span class="dn-ip">${escapeHtml(ip)}</span>` +
		(ports.length ? `:<span class="dn-ports">${escapeHtml(ports.join(","))}</span>` : "")
	);
}

/**
 * The `(hostname)` half of a host title: first real domain/hostname wrapped in
 * parens, tinted; `""` when the host has none. The parens keep the default text
 * colour to match the untinted separators; only the name is coloured.
 */
function renderHostName(host: Host): string {
	const { name } = displayParts(
		host.hostnames,
		host.domains,
		host.ip,
		host.shots.map((s) => s.port),
	);
	return name ? `(<span class="dn-name">${escapeHtml(name)}</span>)` : "";
}

/**
 * One host card for the index grid. The screenshot is a `<figure>` with the image
 * as its CSS background (inline `style`, since the URL is per-card and dynamic), with
 * the shot-count badge overlaid in its corner. The title is a fixed two-line shape
 * (`ip:ports` then `(hostname)`) so every card occupies the same height even when a
 * host has no hostname; location follows on a third line.
 */
export function renderHostCard(host: Host, opts: RenderOpts = {}): string {
	const badge =
		host.count > 1
			? `\n${T(2)}<span class="badge">${host.count} angles</span>`
			: "";
	const loc = [host.city, host.country_name]
		.filter((v): v is string => !!v && v.trim() !== "")
		.map(escapeHtml)
		.join(", ");
	const locLine = loc ? `\n${T(1)}<p class="loc">${loc}</p>` : "";
	// Dev hook: blacklist/tag act on the IP (ref); data-port is the shot the card image is
	// from, used by change-thumbnail (reorder stays per-shot, gated in showOptions).
	const devAttrs = opts.dev ? ` data-kind="cam" data-ref="${escapeHtml(host.ip)}" data-port="${escapeHtml(host.thumbPort)}"` : "";

	const route = hostRoute(host.slug);
	return [
		`<a class="card" href="${urlOf(route)}" hx-get="${snipUrlOf(route)}" hx-push-url="${urlOf(route)}"${devAttrs}>`,
		`${T(1)}<figure role="img" aria-label="${escapeHtml(host.thumbAlt)}" style="background-image:url('${escapeHtml(host.thumbHref)}')">${badge}`,
		`${T(1)}</figure>`,
		`${T(1)}<h2>`,
		`${T(2)}<span class="dn-line">${renderHostPort(host)}</span>`,
		`${T(2)}<span class="dn-sub">${renderHostName(host)}</span>`,
		`${T(1)}</h2>${locLine}`,
		`</a>`,
	].join("\n");
}

/** Inner-<main> content for an index page: the card grid plus the pager. */
export function renderIndexMain(hosts: Host[], page: number, totalPages: number, opts: RenderOpts = {}): string {
	if (hosts.length === 0) {
		return `<p class="empty">No cameras stored yet. Run <code>bun run scrape</code> first.</p>`;
	}
	const cards = hosts.map((h) => indentBlock(renderHostCard(h, opts), 1)).join("\n");
	const pager = renderPager(page, totalPages);
	return galleryBody(cards, pager);
}

// ── Homepage ─────────────────────────────────────────────────────────────────

/**
 * The two "top N" lists shown below the card sections on the homepage: the most-used
 * tags beside the most-common camera makes. Both come pre-sliced (top 10, descending)
 * from build.ts; `slugForTag` maps a tag to its browse-page slug, and `vendorsWithGallery`
 * gates which makes link to a `/fingerprints/<vendor>` gallery (the rest are plain text).
 */
interface HomeExtras {
	topTags: { tag: string; count: number }[];
	topMakes: ProductGroup[];
	slugForTag: (tag: string) => string;
	vendorsWithGallery: Set<string>;
	/** One-off event promoted above everything: a banner linking to the combined /event page. */
	superFeature?: { title: string; posterHref: string; route: string } | null;
}

/**
 * One "top N" column: an underlined heading, a ranked list of `name (count)` rows, then a
 * "more" link to the full listing. `rows` are pre-rendered <li> strings so tags and makes
 * can each build their own link/plain-text markup. Returns "" when there are no rows, so an
 * empty column is dropped rather than showing a bare header.
 */
function renderHomeColumn(title: string, rows: string[], moreHref: string, moreSnip: string, moreLabel: string): string {
	if (rows.length === 0) return "";
	return [
		`<div class="home-col">`,
		`${T(1)}<h2 class="section-title">${escapeHtml(title)}</h2>`,
		`${T(1)}<ol class="top-list">`,
		indentBlock(rows.join("\n"), 2),
		`${T(1)}</ol>`,
		`${T(1)}<a class="more" href="${moreHref}" hx-get="${moreSnip}" hx-push-url="${moreHref}">${escapeHtml(moreLabel)} &rarr;</a>`,
		`</div>`,
	].join("\n");
}

/** A `name (count)` row where the name links somewhere. */
function topRow(href: string, snip: string, name: string, count: number): string {
	return `<li><a href="${href}" hx-get="${snip}" hx-push-url="${href}">${escapeHtml(name)}</a> <span class="cnt">${count.toLocaleString()}</span></li>`;
}

/**
 * Inner-<main> for the homepage (index.html): a curated landing page with cams, streams,
 * and feeds sections (each up to four cards: the featured pins first, then the newest —
 * build.ts assembles the ordering), followed by two "top N" columns (most-used tags beside
 * most-common camera makes). Reuses the gallery cards verbatim; a "more" link jumps to the
 * full paginated gallery. An empty section is dropped, and if everything is empty the
 * galleries' "nothing yet" note shows.
 */
export function renderHomeMain(cams: Host[], streams: YtStream[], feeds: FeedCam[], extras: HomeExtras, opts: RenderOpts = {}): string {
	const section = (title: string, cards: string, moreHref: string, moreSnip: string, moreLabel: string): string =>
		[
			`<section class="home">`,
			`${T(1)}<h2 class="section-title">${escapeHtml(title)}</h2>`,
			`${T(1)}<div class="gallery">`,
			indentBlock(cards, 1),
			`${T(1)}</div>`,
			`${T(1)}<a class="more" href="${moreHref}" hx-get="${moreSnip}" hx-push-url="${moreHref}">${escapeHtml(moreLabel)} &rarr;</a>`,
			`</section>`,
		].join("\n");

	const parts: string[] = [];

	// A super-feature (one-off event) is promoted above everything: a full-width banner with
	// the primary member's image + title, linking to the combined /event page (both live views).
	const sf = extras.superFeature;
	if (sf) {
		const bg = sf.posterHref ? ` style="background-image:url('${escapeHtml(sf.posterHref)}')"` : "";
		parts.push(
			[
				`<a class="super-feature" href="${urlOf(sf.route)}" hx-get="${snipUrlOf(sf.route)}" hx-push-url="${urlOf(sf.route)}">`,
				`${T(1)}<div class="sf-thumb"${bg} role="img" aria-label="${escapeHtml(sf.title)}"></div>`,
				`${T(1)}<div class="sf-body">`,
				`${T(2)}<span class="sf-tag">Live event</span>`,
				`${T(2)}<h2 class="sf-title">${escapeHtml(sf.title)}</h2>`,
				`${T(2)}<span class="sf-more">View event &rarr;</span>`,
				`${T(1)}</div>`,
				`</a>`,
			].join("\n"),
		);
	}

	if (cams.length) {
		const cards = cams.map((h) => indentBlock(renderHostCard(h, opts), 1)).join("\n");
		parts.push(section("cams", cards, urlOf(HOSTS), snipUrlOf(HOSTS), "all cams"));
	}
	if (streams.length) {
		const cards = streams.map((s) => indentBlock(renderYtCard(s, opts), 1)).join("\n");
		parts.push(section("streams", cards, urlOf(STREAMS), snipUrlOf(STREAMS), "all streams"));
	}
	if (feeds.length) {
		const cards = feeds.map((c) => indentBlock(renderFeedCard(c, opts), 1)).join("\n");
		parts.push(section("feeds", cards, urlOf(FEEDS), snipUrlOf(FEEDS), "all feeds"));
	}

	// Two "top N" columns below the card sections. Tags always link to their browse page;
	// a make links to its vendor gallery only when that vendor actually got one this build,
	// otherwise it renders as plain text (still escaped — makes echo banner text).
	const { topTags, topMakes, slugForTag, vendorsWithGallery } = extras;
	const tagRows = topTags.map((t) => {
		const route = tagRoute(slugForTag(t.tag));
		return topRow(urlOf(route), snipUrlOf(route), t.tag, t.count);
	});
	const makeRows = topMakes.map((g) => {
		if (g.vendor && vendorsWithGallery.has(g.vendor)) {
			const route = vendorRoute(g.vendor);
			return topRow(urlOf(route), snipUrlOf(route), g.make, g.total);
		}
		return `<li><span>${escapeHtml(g.make)}</span> <span class="cnt">${g.total.toLocaleString()}</span></li>`;
	});
	const tagsCol = renderHomeColumn("top tags", tagRows, urlOf(TAGS), snipUrlOf(TAGS), "all tags");
	const makesCol = renderHomeColumn("top makes", makeRows, urlOf(FINGERPRINTS), snipUrlOf(FINGERPRINTS), "all fingerprints");
	const cols = [tagsCol, makesCol].filter((c) => c !== "");
	if (cols.length) {
		parts.push([`<section class="home-cols">`, indentBlock(cols.join("\n"), 1), `</section>`].join("\n"));
	}

	if (parts.length === 0) {
		return `<p class="empty">Nothing to feature yet. Run <code>bun scrape</code>, <code>bun import --youtube</code>, <code>bun import --mjpeg</code>, <code>bun import --hls</code>, or <code>bun run osiris</code> first.</p>`;
	}
	return parts.join("\n");
}

function shotFigure(shot: Shot, ip: string, opts: RenderOpts = {}): string {
	const caption = [
		`Port ${escapeHtml(shot.port)}`,
		shot.product && shot.product.trim() ? escapeHtml(shot.product) : "",
		shot.timestamp ? `<time datetime="${escapeHtml(shot.timestamp)}">${escapeHtml(shot.timestamp)}</time>` : "",
	]
		.filter((s) => s !== "")
		.join(" &middot; ");
	// Dev hook: reorder acts on this exact (ip, port); blacklist/tag act on the IP (ref).
	const devAttrs = opts.dev ? ` data-kind="cam" data-ref="${escapeHtml(ip)}" data-port="${escapeHtml(shot.port)}"` : "";
	return [
		`${T(1)}<figure class="shot"${devAttrs}>`,
		`${T(2)}<img src="${escapeHtml(shot.imgHref)}" alt="${escapeHtml(shot.imgAlt)}" loading="lazy" />`,
		`${T(2)}<figcaption>${caption}</figcaption>`,
		`${T(2)}<a class="btn" href="${escapeHtml(shot.liveHref)}" target="_blank" rel="noopener noreferrer">`,
		indentBlock(btnLayers("View live"), 2),
		`${T(2)}</a>`,
		`${T(1)}</figure>`,
	].join("\n");
}

/** Inner-<main> content for a host page: screenshots up top, one shared metadata table. */
export function renderHostMain(host: Host, opts: RenderOpts = {}): string {
	const shots = host.shots.map((s) => shotFigure(s, host.ip, opts)).join("\n");

	const rows: string[] = [];
	pushMetaRow(rows, "Title", host.httpTitle);
	pushMetaRow(rows, "Fingerprint", host.product);
	if (host.hostnames.length) pushMetaRow(rows, "Hostnames", host.hostnames.join(", "));
	if (host.domains.length) pushMetaRow(rows, "Domains", host.domains.join(", "));
	pushMetaRow(rows, "Country", host.country_name);
	pushMetaRow(rows, "City", host.city);
	pushMetaRow(rows, "Region", host.region_code);
	pushMetaRow(rows, "Organization", host.org);
	pushMetaRow(rows, "ISP", host.isp);
	pushMetaRow(rows, "ASN", host.asn);
	rows.push(metaRow("Ports", escapeHtml(host.shots.map((s) => s.port).join(", "))));
	if (host.tags.length) rows.push(metaRow("Tags", renderTagLinks(host.tags, opts.slugForTag)));

	const nameHtml = renderHostName(host);
	const heading = nameHtml ? `${renderHostPort(host)} ${nameHtml}` : renderHostPort(host);

	return detailArticle({
		headingHtml: heading,
		shotsInner: shots,
		rows,
		backRoute: HOSTS,
		backLabel: "hosts",
	});
}
