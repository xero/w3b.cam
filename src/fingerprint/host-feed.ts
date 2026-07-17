// Derive a browser-playable feed URL for a Shodan host (kind='cam') from data we ALREADY
// have — the concrete stream/snapshot path embedded in the host's own stored HTML/JS
// (raw_json.http.html) — reusing the vendor path vocabulary from ingest/mjpeg-source.ts.
// Pure + network-free. Called at ingest by the cam upsert hook (db/store/inserts.ts →
// makeInserter), which persists the URL into cams.live_url on every (re)scrape, and by the
// host renderer, which re-derives the transport from that persisted URL via liveKindFromUrl
// so the two can never drift.
//
// Evidence-only: a path must actually appear in the device's own page. No fingerprint-only
// guessing here — a guessed URL that 404s is a worse lie than showing just the screenshot.

export type LiveKind = "mjpeg" | "jpg";

// Ordered, evidence-based path extractors. Motion-stream paths come first so a live stream
// wins over a still snapshot when a page references both. Each captures a root-relative path
// (starts with "/"); the capture stops at the first quote/space/paren/angle so a query string
// survives but surrounding markup does not. Vocabulary tracks RULES in ingest/mjpeg-source.ts.
const DETECTORS: RegExp[] = [
	/["'`(=]\s*(\/axis-cgi\/mjpg\/video\.cgi[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/mjpg\/(?:\d+\/)?video\.mjpg[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/?\?action=stream[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/[^"'`)\s<>]*nphMotionJpeg[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/[^"'`)\s<>]*video\.mjpg[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/[^"'`)\s<>]*(?:nph[-_])?video\.cgi[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/[^"'`)\s<>]*faststream\.jpg[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/[^"'`)\s<>]*nph-mjpeg\.cgi[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/(?:axis-cgi\/jpg\/image\.cgi|jpg\/image\.jpg)[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/-wvhttp-01-\/[^"'`)\s<>]*)/i,
	/["'`(=]\s*(\/(?:nph-jpeg\.cgi|netcam\.jpg)[^"'`)\s<>]*)/i,
];

// A derived URL is a motion stream if its path is a known multipart/MJPEG endpoint, else a
// single-JPEG snapshot. faststream.jpg is a still UNLESS it carries a stream param. This runs
// on the final URL string so the renderer reaches the exact same verdict the backfill did.
const STREAM_URL = /video\.(?:mjpg|cgi)|nphMotionJpeg|[?&]action=stream|nph-mjpeg\.cgi|faststream\.jpg\?[^]*\bstream=/i;

export function liveKindFromUrl(url: string): LiveKind {
	return STREAM_URL.test(url) ? "mjpeg" : "jpg";
}

// RTSP-only hosts (port 554 & friends, or an RTSP fingerprint) aren't browser-playable —
// callers weed them out before deriving.
const RTSP_PORTS = new Set([554, 10554, 8554, 20001, 10001]);
export function isRtspHost(port: number, product: string | null): boolean {
	return RTSP_PORTS.has(port) || /RTSP/i.test(product ?? "");
}

export interface HostFeed {
	/** The derived media URL (same origin as the host: scheme://ip[:port] + path). */
	liveUrl: string;
	/** mjpeg (multipart stream) or jpg (single snapshot), derived from the URL. */
	kind: LiveKind;
	/** true when https (embeddable in-page); false when http (mixed-content → link only). */
	embeddable: boolean;
}

function cleanPath(raw: string): string {
	// Unescape, then drop a dangling `&key=` / `&` / `?` left when a query value was templated
	// out of the HTML (e.g. `?stream=full&fps=` where the digits were built in JS).
	return raw
		.replace(/\\$/, "")
		.replace(/&amp;/g, "&")
		.replace(/[?&][\w.-]*=?$/g, (s) => (s.endsWith("=") ? "" : s));
}

/**
 * Derive a playable feed URL for one host from its stored Shodan banner, or null when the
 * page references no known stream/snapshot path. Origin is the host's own scheme+ip+port
 * (scheme from the banner's `ssl` presence); the path comes from the device's HTML/JS.
 */
export function deriveHostFeed(rawJson: string, ip: string, port: number): HostFeed | null {
	let j: unknown;
	try {
		j = JSON.parse(rawJson);
	} catch {
		return null;
	}
	if (!j || typeof j !== "object") return null;
	const obj = j as Record<string, unknown>;
	const http = (obj.http ?? null) as Record<string, unknown> | null;
	const html = `${typeof http?.html === "string" ? http.html : ""}\n${typeof obj.data === "string" ? obj.data : ""}`;
	if (!html.trim()) return null;

	let path: string | null = null;
	for (const re of DETECTORS) {
		const m = html.match(re);
		if (m && m[1]) {
			path = cleanPath(m[1]);
			break;
		}
	}
	if (!path) return null;

	const scheme = "ssl" in obj ? "https" : "http";
	const host = ip.includes(":") ? `[${ip}]` : ip;
	const isDefaultPort = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
	const origin = `${scheme}://${host}${isDefaultPort ? "" : `:${port}`}`;
	const liveUrl = origin + (path.startsWith("/") ? path : `/${path}`);
	return { liveUrl, kind: liveKindFromUrl(liveUrl), embeddable: scheme === "https" };
}
