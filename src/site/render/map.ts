import { T, MAP_W, MAP_H } from "./primitives.ts";
import { WORLD_PATHS } from "../worldmap.ts";
import { escapeHtml } from "../../core/util.ts";

// ── World map ────────────────────────────────────────────────────────────────
// A single page plotting every geolocated camera (all three sources) as a dot on a
// baked SVG world map. The country outlines (worldmap.ts) and the dots share one
// viewBox, so the whole thing is one inert SVG: hover a dot for its location (native
// <title>), click it to open that cam (a real <a>, htmx-swapped when JS is on).
// assets/map.js adds drag-to-pan / wheel-to-zoom by nudging the viewBox; with no JS
// it stays a fixed world view, still fully clickable.

export interface MapPoint {
	/** Projected viewBox coordinates (see project()). */
	x: number;
	y: number;
	/** Detail-page pretty URL: the no-JS href and the pushed history entry. */
	href: string;
	/** Detail-page snippet URL: the htmx swap target. */
	snip: string;
	/** Hover label: the cam's location, else its name. */
	title: string;
}

/** Trim a trailing ".0" so projected coords stay compact across ~10k dots. */
const mapRound = (n: number): string => {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
};

/**
 * Inner-<main> for the map page: one SVG holding the world outlines and a dot per
 * geolocated camera. Each dot is an <a> to the cam's detail page (a plain link
 * without JS, an htmx body-swap with it) carrying a <title> for a native hover
 * tooltip. `total` is only for the SVG's accessible label.
 */
export function renderMapMain(points: MapPoint[], total: number): string {
	if (points.length === 0) {
		return `<p class="empty">No geolocated cameras yet. Scrape cams, add feed, or assign stream coordinates with <code>bun run geo</code>, then re-bake.</p>`;
	}
	const land = WORLD_PATHS.map((d) => `${T(3)}<path d="${d}" />`).join("\n");
	const dots = points
		.map(
			(p) =>
				`${T(3)}<a href="${p.href}" hx-get="${p.snip}" hx-push-url="${p.href}"><circle cx="${mapRound(p.x)}" cy="${mapRound(p.y)}" r="1.4"><title>${escapeHtml(p.title)}</title></circle></a>`,
		)
		.join("\n");
	return [
		`<section class="mapwrap">`,
		`${T(1)}<p class="maphint">${total.toLocaleString()} geolocated cameras &middot; drag to pan, scroll to zoom, click a dot to open it</p>`,
		`${T(1)}<svg class="worldmap" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet" aria-label="World map of ${total.toLocaleString()} geolocated cameras">`,
		`${T(2)}<g class="land" aria-hidden="true">`,
		land,
		`${T(2)}</g>`,
		`${T(2)}<g class="dots">`,
		dots,
		`${T(2)}</g>`,
		`${T(1)}</svg>`,
		`</section>`,
	].join("\n");
}
