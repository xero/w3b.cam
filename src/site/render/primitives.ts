// Leaf render helpers: indentation, safe-parse, MIME allowlist, the live-view URL, the
// map projection, and the shared RenderOpts. No view models, no IO — imported everywhere.

/** Map viewBox size. The world outlines in worldmap.ts are pre-projected into this space. */
export const MAP_W = 1000;
export const MAP_H = 500;

/** Equirectangular projection of a coordinate into the map viewBox (must match worldmap.ts). */
export function project(lat: number, lng: number): { x: number; y: number } {
	return { x: ((lng + 180) / 360) * MAP_W, y: ((90 - lat) / 180) * MAP_H };
}

/** Tab of depth n (web-style: tabs, never spaces). */
export const T = (n: number): string => "\t".repeat(n);

/** Prefix every non-empty line of a block with `level` tabs. */
export function indentBlock(text: string, level: number): string {
	const pad = T(level);
	return text
		.split("\n")
		.map((l) => (l.length ? pad + l : l))
		.join("\n");
}

export function safeParseArray(json: string): string[] {
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// The base64 image is inert once decoded to a file, but validate the MIME against an
// allowlist so a hostile `mime` string can't pick an unexpected extension.
const SAFE_MIME = /^image\/(jpeg|png|gif|webp|bmp)$/;
const MIME_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
};

/** File extension for a screenshot, allowlisted; defaults to jpg. */
export function extFromMime(mime: string): string {
	return SAFE_MIME.test(mime) ? (MIME_EXT[mime] ?? "jpg") : "jpg";
}

/** Whether a MIME string is an image type we allow to be stored/baked (see SAFE_MIME). */
export const isSafeImageMime = (mime: string): boolean => SAFE_MIME.test(mime);

// The page/snippet URL + slug helpers now live in src/site/urls.ts (imported above): the
// route model (urlOf/snipUrlOf), the per-section route builders, and the slug functions.

/**
 * Live-view URL for a host:port (external link, opened in a new tab). IPv6 literals
 * are bracketed; scheme-default ports are dropped for clean URLs. 443 -> https, 554
 * -> rtsp, 80 -> bare http, everything else -> http on the explicit port.
 */
export function liveUrl(ip: string, port: number): string {
	const host = ip.includes(":") ? `[${ip}]` : ip;
	switch (port) {
		case 443:
			return `https://${host}/`;
		case 554:
			return `rtsp://${host}/`;
		case 80:
			return `http://${host}/`;
		default:
			return `http://${host}:${port}/`;
	}
}

/**
 * Rendering toggles, threaded as a trailing optional param (default `{}`) so every
 * production call is unchanged. `dev` bakes data-* hooks onto cards/shots/details and
 * injects the dev client. `slugForTag` maps a tag to its browse-page slug so the
 * detail-page "Tags" row can link each tag; absent (production galleries never need
 * it) means tags render as plain text.
 */
export interface RenderOpts {
	dev?: boolean;
	slugForTag?: (tag: string) => string;
}
