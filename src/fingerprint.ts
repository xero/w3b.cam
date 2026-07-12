// Fingerprint: derive the real camera device (vendor + model where possible) from a
// stored Shodan banner or a feed feed URL, and write it to the `product` field the
// site renders as "Fingerprint" (see render.ts). Shodan's own `product` is a mixed
// bag — often empty, often just the web server (`Apache httpd`, `nginx`, `Boa`) rather
// than the camera. This mines the full banner (http.title, the `hikvision` block,
// cpe23, http.server, http.html path fragments, and the RTSP `data` banner) through an
// ordered cascade, highest-confidence signal first, and records every decision in a
// `fingerprints` table so a run is reviewable and reversible.
//
// The classifiers (fingerprintWebcam / fingerprintFeed) are pure so ingesters can
// adopt them later; this file's CLI is the batch backfill.
//
// Usage:
//   DB_PATH=camhunting.fp.sqlite bun run fingerprint            # dry run: audit + report only
//   DB_PATH=camhunting.fp.sqlite bun run fingerprint --apply    # write product + feed column

import { Database } from "bun:sqlite";
import { DB_PATH } from "./config.ts";
import { allRows, allFeedRows, closeDb, openDb } from "./db.ts";
import type { ProductGroup, StoredRow } from "./types.ts";

// ── Result shape ────────────────────────────────────────────────────────────────

/** Confidence in a derived fingerprint. `high` = exact model / vendor from a direct
 * self-report (title, hik block, cpe, distinctive server); `medium` = vendor family
 * from an endpoint path or RTSP server; `low` = a generic floor label. */
export type Tier = "high" | "medium" | "low";

export interface FpResult {
	/** The label written to `product`, e.g. "Axis M3027" or "Dahua-family (RTSP)". */
	product: string;
	/** Coarse vendor/family key for aggregation (favicon inheritance, reporting). */
	vendor: string;
	/** Which signal matched, e.g. "title", "hik-block", "html-path", "rtsp", "server". */
	method: string;
	tier: Tier;
	/** The raw signal value that drove the match, for the audit trail. */
	evidence: string;
}

// ── Signal extraction from a parsed raw_json ─────────────────────────────────────

interface Signals {
	title: string;
	server: string;
	html: string;
	data: string;
	favicon: number | null;
	hik: boolean;
	cpe: string; // cpe23 joined lowercase
}

/** Pull the fields the cascade reads out of a parsed Shodan match object. */
function signalsFrom(raw: Record<string, unknown>): Signals {
	const http = (raw.http ?? {}) as Record<string, unknown>;
	const favObj = (http.favicon ?? null) as Record<string, unknown> | null;
	const cpe23 = raw.cpe23;
	return {
		title: str(http.title),
		server: str(http.server),
		html: str(http.html),
		data: str(raw.data),
		favicon: favObj && typeof favObj.hash === "number" ? (favObj.hash as number) : null,
		hik: raw.hikvision != null,
		cpe: Array.isArray(cpe23) ? cpe23.join(" ").toLowerCase() : "",
	};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

// ── Title-driven model extraction (highest confidence) ───────────────────────────

/**
 * Extract an exact vendor + model from a page title when it names one. Titles are the
 * strongest self-report a camera gives; these patterns come straight from observed
 * values in the DB and the vendor notes.
 */
function fromTitle(title: string): FpResult | null {
	const t = title.trim();
	if (!t) return null;
	const hit = (product: string, vendor: string): FpResult => ({ product, vendor, method: "title", tier: "high", evidence: t.slice(0, 120) });

	let m: RegExpMatchArray | null;
	// Axis: "AXIS M1113 Network Camera", "AXIS Q1755", bare "AXIS".
	if ((m = t.match(/\bAXIS\s+([A-Z]?\d{3,4}[A-Z0-9-]*)/))) return hit(`Axis ${m[1]}`, "axis");
	if (/^AXIS\b/.test(t)) return hit("Axis (model unknown)", "axis");
	// Panasonic / i-PRO: "WV-SF438 Network Camera", "BB-SC382 Network Camera", "DG-SP304".
	if ((m = t.match(/\b((?:WV|BB|DG|BL|BM|BY|NP|NW|KX)-[A-Z0-9]+)\b/))) return hit(`Panasonic/i-PRO ${m[1]}`, "panasonic");
	// Canon: "Network Camera VB-C60", "Network Camera VB-M40".
	if ((m = t.match(/\b(VB-[A-Z0-9]+)\b/))) return hit(`Canon ${m[1]}`, "canon");
	// Hikvision explicit model.
	if ((m = t.match(/\b(DS-[A-Z0-9-]{3,})\b/))) return hit(`Hikvision ${m[1]}`, "hikvision");
	// D-Link explicit model.
	if ((m = t.match(/\b(DCS-[A-Z0-9]+)\b/))) return hit(`D-Link ${m[1]}`, "dlink");
	// Trendnet explicit model.
	if ((m = t.match(/\b(TV-IP[A-Z0-9]+)\b/))) return hit(`Trendnet ${m[1]}`, "trendnet");
	// Xiongmai OEM firmware UI.
	if (/NETSurveillance/i.test(t)) return hit("Xiongmai (NetSurveillance/uc-httpd)", "xiongmai");
	// Mobotix default hostname title ("mx10-20-132-213") or explicit name.
	if (/\bMOBOTIX\b/i.test(t) || /^mx\d/i.test(t)) return hit("Mobotix", "mobotix");
	// StarDot NetCam SC.
	if (/NetCamSC/i.test(t)) return hit("StarDot NetCam SC", "stardot");
	// Intelbras (Dahua OEM, Brazil).
	if (/^INTELBRAS/i.test(t)) return hit("Intelbras", "intelbras");
	// IQinVision / IQeye: title names the model, e.g. "IQeye511DV ...", "IQeye755 ...".
	if ((m = t.match(/\b(IQeye\d+[A-Z]*)\b/i))) return hit(`IQinVision ${m[1]}`, "iqinvision");
	// Blue Iris NVR software (Windows) aggregating cameras behind a web UI.
	if (/Blue Iris/i.test(t)) return hit("Blue Iris (NVR software)", "blueiris");
	// DIY / hobbyist MJPEG streamer (Raspberry Pi & friends).
	if (/MJPG[-_ ]?streamer/i.test(t)) return hit("mjpg-streamer (DIY/RPi)", "mjpg-streamer");
	// Camera software packages that legitimately self-title.
	if ((m = t.match(/webcamXP\s*(\d+)?/i))) return hit(m[1] ? `webcamXP ${m[1]}` : "webcamXP", "webcamxp");
	if (/\bYawcam\b/i.test(t)) return hit("Yawcam", "yawcam");
	if (/^webcam 7\b/i.test(t)) return hit("webcam 7", "webcam7");
	return null;
}

// ── Distinctive HTTP server banners ──────────────────────────────────────────────

/**
 * Map an HTTP `Server:` banner (or a Server line lifted from an HTTP `data` banner) to
 * a device. Only banners that are actually device-distinctive are mapped; a bare
 * `Apache`/`nginx`/`Boa`/`thttpd` is a web server shared by countless devices, so it
 * falls through to weaker signals rather than being emitted as a fingerprint.
 */
function fromServer(server: string): FpResult | null {
	const s = server.trim();
	if (!s) return null;
	const l = s.toLowerCase();
	const hit = (product: string, vendor: string, tier: Tier): FpResult => ({ product, vendor, method: "server", tier, evidence: s.slice(0, 120) });

	if (l.startsWith("vcs-videojet")) return hit("Bosch VideoJet", "bosch", "high");
	if (l === "vb" || l.startsWith("vb/") || l.startsWith("vb ")) return hit("Canon VB (Network Camera)", "canon", "high");
	if (l.startsWith("ver2.4 rev0")) return hit("Panasonic/i-PRO", "panasonic", "high"); // i-PRO web server banner
	if (l.includes("uc-httpd")) return hit("Xiongmai (uc-httpd)", "xiongmai", "high");
	if (l.includes("hikvision") || l.includes("dvrdvs-webs") || l.includes("app-webs")) return hit("Hikvision IP Camera", "hikvision", "high");
	// D-Link/Airlink OEM: "Camera Web Server/1.0" + "Auther: Steven Wu" + top.htm?Currenttime= redirect.
	if (l.startsWith("camera web server")) return hit("D-Link/Airlink IP camera", "dlink-airlink", "high");
	if (l.startsWith("cam-webs")) return hit("IP camera (Cam-Webs)", "generic", "medium");
	if (l.includes("mjpg-streamer")) return hit("mjpg-streamer (DIY/RPi)", "mjpg-streamer", "high");
	if (l.startsWith("hipcam")) return hit("Hipcam/HiSilicon-family", "hipcam", "medium");
	if (l.startsWith("iqinvision")) return hit("IQinVision IQeye", "iqinvision", "high");
	if (l.startsWith("blueiris")) return hit("Blue Iris (NVR software)", "blueiris", "high");
	// "gen5th" is a distinctive embedded camera web server; vendor not confirmed, so name the server, not a guess.
	if (l.startsWith("gen5th")) return hit("IP camera (gen5th httpd)", "gen5th", "medium");
	return null;
}

// ── HTML path fragments (endpoint fingerprints from the vendor notes) ─────────────

const HTML_RULES: { re: RegExp; product: string; vendor: string }[] = [
	{ re: /axis-cgi\//i, product: "Axis", vendor: "axis" },
	{ re: /cam\/realmonitor/i, product: "Dahua-family", vendor: "dahua" },
	{ re: /tmpfs\/(?:snap|auto2?)\.jpg|\/cgi-bin\/hi3510\//i, product: "hi3510/INSTAR-family", vendor: "hi3510" },
	{ re: /streaming\/channels/i, product: "Hikvision IP Camera", vendor: "hikvision" },
	{ re: /getimage\?fmt/i, product: "LILIN", vendor: "lilin" },
	{ re: /video\/mjpg\.cgi/i, product: "Trendnet", vendor: "trendnet" },
	{ re: /\/media2?\/video\d|lapi\/v1\.0/i, product: "Uniview", vendor: "uniview" },
	{ re: /faststream\.jpg|guestimage\.html|userimage\.html/i, product: "Mobotix", vendor: "mobotix" },
	{ re: /nphmotionjpeg|cgistart\?page=/i, product: "Panasonic/i-PRO", vendor: "panasonic" },
	{ re: /getmjstream|cgistream\.cgi/i, product: "Foscam", vendor: "foscam" },
	// live*.sdp / video.mjpg are the D-Link/Vivotek OEM family; keep them late (broad).
	{ re: /live\d?\.sdp|video1?\.mjpg/i, product: "Vivotek/D-Link-family", vendor: "vivotek-dlink" },
];

function fromHtml(html: string): FpResult | null {
	if (!html) return null;
	for (const r of HTML_RULES) {
		if (r.re.test(html)) return { product: r.product, vendor: r.vendor, method: "html-path", tier: "medium", evidence: r.re.source };
	}
	return null;
}

// ── RTSP / HTTP data banner ───────────────────────────────────────────────────────

/** The value of the first `Server:` header in a raw banner, or "". */
function serverLine(data: string): string {
	const m = data.match(/^Server:\s*(.+?)\s*$/im);
	return m && m[1] ? m[1].trim() : "";
}

/**
 * Classify a raw `data` banner for rows Shodan did not parse into an http block. These
 * are dominated by RTSP services (port 554 &c.) whose `Server:` header names the
 * device family. RTSP and HTTP are handled separately so a generic HTTP web-server
 * string never leaks out as a fingerprint.
 */
function fromData(data: string): FpResult | null {
	const d = data.trimStart();
	if (!d) return null;
	if (/^RTSP\//.test(d)) {
		const sv = serverLine(d);
		const l = sv.toLowerCase();
		const hit = (product: string, vendor: string, tier: Tier): FpResult => ({ product, vendor, method: "rtsp", tier, evidence: (sv || "RTSP (no server)").slice(0, 120) });
		if (l.includes("hipcam")) return hit("Hipcam/HiSilicon-family (RTSP)", "hipcam", "medium");
		if (l.includes("h264dvr")) return hit("H264 DVR (Dahua/Xiongmai-family)", "h264dvr", "medium");
		if (l.startsWith("tvt")) return hit("TVT Digital (RTSP)", "tvt", "medium");
		if (l.includes("ubnt")) return hit("Ubiquiti (RTSP)", "ubiquiti", "medium");
		if (l.includes("videojet")) return hit("Bosch VideoJet (RTSP)", "bosch", "medium");
		if (l.includes("crestron")) return hit("Crestron (RTSP)", "crestron", "medium");
		if (l.startsWith("vb")) return hit("Canon VB (RTSP)", "canon", "high");
		if (l.startsWith("ver2.4 rev0")) return hit("Panasonic/i-PRO (RTSP)", "panasonic", "high");
		// A real RTSP camera, vendor not named: the honest floor.
		return hit("RTSP camera (generic)", "rtsp", "low");
	}
	if (/^HTTP\//.test(d)) {
		// Some rows carry the HTTP banner only in `data`; reuse the server rules.
		const viaServer = fromServer(serverLine(d));
		if (viaServer) return { ...viaServer, method: "data-http" };
	}
	return null;
}

// ── The webcam cascade ────────────────────────────────────────────────────────────

/**
 * Derive a device fingerprint for one stored webcam from its raw Shodan banner, or null
 * if no signal is strong enough. Ordered highest-confidence first (self-reported model,
 * then vendor blocks, then endpoint paths, then RTSP servers, then a generic floor).
 * `favicon` inheritance (rule 8) is applied by the CLI in a second pass, not here.
 */
export function fingerprintWebcam(rawJson: string | Record<string, unknown>): FpResult | null {
	let raw: Record<string, unknown>;
	try {
		raw = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
	} catch {
		return null;
	}
	const sig = signalsFrom(raw);

	// 1. Hikvision enrichment block — definitive vendor; upgrade to a model if the title names one.
	if (sig.hik) {
		const m = sig.title.match(/\b(DS-[A-Z0-9-]{3,})\b/);
		const model = m && m[1] ? m[1] : "";
		return {
			product: model ? `Hikvision ${model}` : "Hikvision IP Camera",
			vendor: "hikvision",
			method: "hik-block",
			tier: "high",
			evidence: model || "hikvision module",
		};
	}

	// 2. Title-named model.
	const byTitle = fromTitle(sig.title);
	if (byTitle) return byTitle;

	// 3. CPE23 vendor (only the device-distinctive one; jQuery/Apache CPEs are noise).
	if (sig.cpe.includes("xiongmaitech")) return { product: "Xiongmai (uc-httpd)", vendor: "xiongmai", method: "cpe", tier: "high", evidence: "cpe:xiongmaitech" };

	// 4. Distinctive HTTP server banner.
	const byServer = fromServer(sig.server);
	if (byServer) return byServer;

	// 5. HTML endpoint path fragments.
	const byHtml = fromHtml(sig.html);
	if (byHtml) return byHtml;

	// 6/7. RTSP or HTTP `data` banner.
	const byData = fromData(sig.data);
	if (byData) return byData;

	// 9. Generic title floor.
	const gt = sig.title.trim().toLowerCase();
	if (gt === "network camera" || gt === "ip camera" || gt === "ip camera viewer") {
		return { product: "Generic IP camera", vendor: "generic", method: "title-generic", tier: "low", evidence: sig.title.trim().slice(0, 120) };
	}
	return null;
}

// ── Feed feed-URL fingerprints ───────────────────────────────────────────────

const FEED_RULES: { re: RegExp; product: string; vendor: string; tier: Tier }[] = [
	{ re: /axis-cgi\//i, product: "Axis", vendor: "axis", tier: "high" },
	{ re: /\/control\/(?:user|guest)image\.html|faststream\.jpg/i, product: "Mobotix", vendor: "mobotix", tier: "high" },
	{ re: /nphmotionjpeg|cgistart/i, product: "Panasonic/i-PRO", vendor: "panasonic", tier: "high" },
	{ re: /-wvhttp-01-/i, product: "Canon VB", vendor: "canon", tier: "high" },
	{ re: /cam\/realmonitor/i, product: "Dahua-family", vendor: "dahua", tier: "medium" },
	{ re: /streaming\/channels|\/isapi\//i, product: "Hikvision", vendor: "hikvision", tier: "medium" },
	// Bare Axis-style MJPEG path with no vendor cgi: honest generic floor.
	{ re: /\/mjpg\/video\.mjpg|\/video\.mjpg/i, product: "MJPEG camera (generic)", vendor: "generic", tier: "low" },
];

/**
 * Derive a device fingerprint for a feed (Osiris) cam from its live URL, or null when
 * the URL exposes no device (operator networks like TfL/Caltrans serve from cloud
 * storage or managed endpoints — their `source` already names the network).
 */
export function fingerprintFeed(row: { live_url?: string | null; source?: string | null }): FpResult | null {
	const url = (row.live_url ?? "").trim();
	if (!url) return null;
	for (const r of FEED_RULES) {
		if (r.re.test(url)) return { product: r.product, vendor: r.vendor, method: "feed-url", tier: r.tier, evidence: r.re.source };
	}
	return null;
}

// ── Normalization of existing products (anti-downgrade) ───────────────────────────

/**
 * Products Shodan already stores that are servers, not devices — always re-fingerprint.
 * RDP/VNC are deliberately absent: they are non-camera services the build already filters
 * (isBlockedProduct) and must keep their product, so they are never treated as a camera
 * target nor swept into the generic-camera floor.
 */
const SERVER_PRODUCTS = new Set([
	"apache httpd", "boa web server", "boa httpd", "uc-httpd", "thttpd", "dd-wrt milli_httpd",
	"nginx", "lighttpd", "mini_httpd", "goahead embedded web server", "openresty", "blue server",
]);

const GENERIC_LABELS = new Set([
	"Generic IP camera", "RTSP camera (generic)", "MJPEG camera (generic)", "IP camera (Cam-Webs)",
]);

/** True when a product is empty or a server name (the primary fingerprint targets). */
function isServerOrEmpty(p: string | null | undefined): boolean {
	const t = (p ?? "").trim();
	return t === "" || SERVER_PRODUCTS.has(t.toLowerCase());
}

/** Strip Shodan's descriptive suffixes so an existing good product displays uniformly. */
function canonicalizeExisting(p: string): string {
	return p
		.replace(/\s+webcam http config$/i, "")
		.replace(/\s+webcam http interface$/i, "")
		.replace(/\s+Network Camera http config$/i, "")
		.replace(/\s+http config$/i, "")
		.trim();
}

/**
 * Specificity rank for the anti-downgrade guard: 3 = a concrete model number, 2 = a
 * known vendor/family, 1 = a generic floor. An existing good product is only replaced
 * when the derived label is at least as specific.
 */
function specificity(label: string): number {
	if (GENERIC_LABELS.has(label)) return 1;
	// Treat H264/H265 as codec noise, not a model number, before the digit test.
	const cleaned = label.replace(/h\.?26[45]/gi, "");
	if (/\d{2,}/.test(cleaned)) return 3;
	return 2;
}

// ── Audit + decision plumbing ─────────────────────────────────────────────────────

type Action = "fill" | "fix-server" | "upgrade" | "normalize" | "keep" | "unknown";

interface Decision {
	kind: "cam" | "feed";
	ref: string;
	old: string | null;
	next: string | null;
	tier: Tier | "-";
	method: string;
	vendor: string;
	evidence: string;
	action: Action;
}

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS fingerprints (
	kind      TEXT NOT NULL,   -- 'cam' | 'feed'
	ref       TEXT NOT NULL,   -- cams.id: 'ip:port' for cams, feed id for feeds
	old_value TEXT,
	new_value TEXT,
	tier      TEXT,
	method    TEXT,
	vendor    TEXT,
	evidence  TEXT,
	action    TEXT NOT NULL,   -- fill | fix-server | upgrade | normalize | keep | unknown
	PRIMARY KEY (kind, ref)
) STRICT;
`;

/** Decide what (if anything) to write for one webcam row, given its cascade result. */
function decideWebcam(row: StoredRow, fp: FpResult | null): Decision {
	const ref = `${row.ip_str}:${row.port}`;
	const old = row.product;
	const base = { kind: "cam" as const, ref, old, vendor: fp?.vendor ?? "-", evidence: fp?.evidence ?? "" };

	if (isServerOrEmpty(old)) {
		// Target row: take any tier the cascade produced.
		if (fp) return { ...base, next: fp.product, tier: fp.tier, method: fp.method, action: (old ?? "").trim() === "" ? "fill" : "fix-server" };
		return { ...base, next: null, tier: "-", method: fp ? "" : "none", action: "unknown" };
	}

	// Existing good product: normalize, and upgrade only on an equal-or-more-specific high-tier hit.
	const canon = canonicalizeExisting(old as string);
	if (fp && fp.tier === "high" && fp.product !== old && specificity(fp.product) >= specificity(canon)) {
		return { ...base, next: fp.product, tier: fp.tier, method: fp.method, action: "upgrade" };
	}
	if (canon !== old) return { ...base, next: canon, tier: "-", method: "canon", action: "normalize" };
	return { ...base, next: old, tier: "-", method: "kept", action: "keep" };
}

// ── Favicon inheritance (rule 8) ──────────────────────────────────────────────────

/**
 * Build a favicon-hash → dominant vendor map from the high-confidence decisions, then
 * label still-unknown rows that share a known hash. A camera model ships a fixed
 * favicon, so a hash that maps overwhelmingly to one vendor is a reliable tell. Kept
 * conservative: only a hash whose high-tier rows are ≥90% one vendor (min 3 rows) is
 * trusted, and only vendor-level (medium tier) is inferred, never a specific model.
 */
function faviconInherit(rows: StoredRow[], byRef: Map<string, Decision>, faviconOf: Map<string, number>): number {
	const tally = new Map<number, Map<string, number>>();
	for (const r of rows) {
		const ref = `${r.ip_str}:${r.port}`;
		const d = byRef.get(ref);
		const fav = faviconOf.get(ref);
		if (fav == null || !d || d.action === "unknown" || d.vendor === "-" || d.vendor === "generic" || d.vendor === "rtsp") continue;
		const inner = tally.get(fav) ?? new Map<string, number>();
		inner.set(d.vendor, (inner.get(d.vendor) ?? 0) + 1);
		tally.set(fav, inner);
	}
	// Resolve each hash to a trusted dominant vendor + a representative product label.
	const dominant = new Map<number, { vendor: string; product: string }>();
	const labelFor = new Map<string, string>([
		["axis", "Axis"], ["panasonic", "Panasonic/i-PRO"], ["hikvision", "Hikvision IP Camera"],
		["dahua", "Dahua-family"], ["xiongmai", "Xiongmai (uc-httpd)"], ["mobotix", "Mobotix"],
		["canon", "Canon VB"], ["dlink", "D-Link"], ["dlink-airlink", "D-Link/Airlink IP camera"],
		["vivotek-dlink", "Vivotek/D-Link-family"], ["trendnet", "Trendnet"], ["foscam", "Foscam"],
		["uniview", "Uniview"], ["lilin", "LILIN"], ["bosch", "Bosch VideoJet"], ["intelbras", "Intelbras"],
		["hi3510", "hi3510/INSTAR-family"],
	]);
	for (const [fav, inner] of tally) {
		let total = 0;
		let best = "";
		let bestN = 0;
		for (const [v, n] of inner) {
			total += n;
			if (n > bestN) { bestN = n; best = v; }
		}
		if (total >= 3 && bestN / total >= 0.9 && labelFor.has(best)) {
			dominant.set(fav, { vendor: best, product: labelFor.get(best) as string });
		}
	}
	// Apply to unknown rows sharing a trusted hash.
	let applied = 0;
	for (const r of rows) {
		const ref = `${r.ip_str}:${r.port}`;
		const d = byRef.get(ref);
		if (!d || d.action !== "unknown") continue;
		const fav = faviconOf.get(ref);
		const dom = fav != null ? dominant.get(fav) : undefined;
		if (!dom) continue;
		d.next = dom.product;
		d.tier = "medium";
		d.method = "favicon";
		d.vendor = dom.vendor;
		d.evidence = `favicon ${fav}`;
		d.action = isServerOrEmpty(d.old) && (d.old ?? "").trim() === "" ? "fill" : "fix-server";
		applied++;
	}
	return applied;
}

// ── Make / model split for the tags-page breakdown ───────────────────────────────

/**
 * Known makes, matched as a case-insensitive prefix of a product label. Ordered so a
 * compound make ("Panasonic/i-PRO") is tried before the bare one it contains
 * ("Panasonic"); the first match wins. Covers every label the classifier emits plus the
 * curated products the DB already held (Apexis, Vivotek, the Dahua-based NVR).
 */
const MAKE_PREFIXES = [
	"Panasonic/i-PRO", "D-Link/Airlink", "Vivotek/D-Link", "Hipcam/HiSilicon", "hi3510/INSTAR",
	"TVT Digital", "H264 DVR", "Blue Iris", "StarDot", "IQinVision", "EarthCam",
	"Axis", "Panasonic", "Canon", "Hikvision", "D-Link", "Trendnet", "Xiongmai", "Mobotix", "Dahua",
	"Ubiquiti", "Bosch", "Crestron", "LILIN", "Foscam", "Uniview", "Intelbras", "Vivotek", "Apexis",
	"mjpg-streamer", "webcamXP", "Yawcam", "webcam 7",
];

/** Display-make aliases: fold near-duplicate vendor names into one row. */
const MAKE_ALIAS: Record<string, string> = { Panasonic: "Panasonic/i-PRO" };

/** Low-confidence floor labels → a single "Unidentified" make with a descriptive model. */
const FLOOR_MODEL: Record<string, string> = {
	"Generic IP camera": "generic (HTTP)",
	"RTSP camera (generic)": "generic (RTSP)",
	"MJPEG camera (generic)": "generic (MJPEG)",
	"IP camera (Cam-Webs)": "Cam-Webs httpd",
	"IP camera (gen5th httpd)": "gen5th httpd",
};

/** Tidy the remainder of a product label (after the make) into a model, or null when only the make is known. */
function cleanModel(rest: string): string | null {
	let m = rest.trim();
	m = m.replace(/-based\s+/i, ""); // "Dahua-based CM-Hybrid NVR ..." -> "CM-Hybrid NVR ..."
	m = m.replace(/-family/gi, "").trim();
	m = m.replace(/\s*\((?:RTSP|Network Camera|DIY\/RPi|NVR software)\)\s*$/gi, "").trim();
	const paren = m.match(/^\((.+)\)$/); // "(uc-httpd)" / "(NetSurveillance/uc-httpd)" -> inner text
	if (paren && paren[1]) m = paren[1].trim();
	if (/^model unknown$/i.test(m)) return "unknown";
	if (/^ip camera$/i.test(m)) return null;
	return m === "" ? null : m;
}

/**
 * Split a product fingerprint into a display make and model for the breakdown table.
 * The label vocabulary is closed (this file emits it), so this is a lookup, not a guess;
 * anything unrecognized falls to make "Other" with the whole label as the model.
 */
export function splitProduct(product: string): { make: string; model: string | null } {
	const p = product.trim();
	if (FLOOR_MODEL[p]) return { make: "Unidentified", model: FLOOR_MODEL[p] as string };
	const lp = p.toLowerCase();
	for (const mk of MAKE_PREFIXES) {
		const lmk = mk.toLowerCase();
		if (lp === lmk || (lp.startsWith(lmk) && /[ \-/(]/.test(p.charAt(mk.length)))) {
			return { make: MAKE_ALIAS[mk] ?? mk, model: cleanModel(p.slice(mk.length)) };
		}
	}
	return { make: "Other", model: p };
}

/** Non-camera products the site filters from display; excluded from the breakdown too. */
const NON_CAMERA = new Set(["remote desktop protocol", "vnc"]);

/** One product occurrence for the breakdown: its label, plus the fingerprint vendor when known. */
export interface BreakdownEntry {
	product: string | null | undefined;
	/** Fingerprint `vendor` slug for this row (from the fingerprints table), or null. */
	vendor?: string | null;
}

/**
 * Aggregate product fingerprints into a make → model → count breakdown, makes ordered by
 * total (descending) with the catch-all "Unidentified"/"Other" makes sunk to the bottom.
 * Empty and non-camera products are skipped. Each group also gets its dominant `vendor`
 * slug (the most common non-null vendor among its products) so the fingerprints page can
 * link the make to its per-vendor gallery; floor makes get no vendor (they span several).
 */
export function productBreakdown(entries: BreakdownEntry[]): ProductGroup[] {
	const makes = new Map<string, Map<string, number>>();
	const vendorTally = new Map<string, Map<string, number>>(); // make -> vendor -> count
	for (const e of entries) {
		const p = (e.product ?? "").trim();
		if (!p || NON_CAMERA.has(p.toLowerCase())) continue;
		const { make, model } = splitProduct(p);
		const label = model ?? "—";
		const inner = makes.get(make) ?? new Map<string, number>();
		inner.set(label, (inner.get(label) ?? 0) + 1);
		makes.set(make, inner);
		const v = (e.vendor ?? "").trim();
		if (v) {
			const vt = vendorTally.get(make) ?? new Map<string, number>();
			vt.set(v, (vt.get(v) ?? 0) + 1);
			vendorTally.set(make, vt);
		}
	}
	const isFloor = (m: string) => m === "Unidentified" || m === "Other";
	const dominantVendor = (make: string): string | null => {
		if (isFloor(make)) return null; // a floor make blends several vendors; no single link
		const vt = vendorTally.get(make);
		if (!vt) return null;
		let best: string | null = null;
		let bestN = 0;
		for (const [v, n] of vt) if (n > bestN) { bestN = n; best = v; }
		return best;
	};
	const groups: ProductGroup[] = [];
	for (const [make, inner] of makes) {
		const models = [...inner.entries()]
			.map(([model, count]) => ({ model, count }))
			.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
		groups.push({ make, total: models.reduce((n, m) => n + m.count, 0), models, vendor: dominantVendor(make) });
	}
	groups.sort((a, b) => {
		const af = isFloor(a.make);
		const bf = isFloor(b.make);
		if (af !== bf) return af ? 1 : -1;
		return b.total - a.total || a.make.localeCompare(b.make);
	});
	return groups;
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function main(): void {
	const apply = process.argv.includes("--apply");
	const force = process.argv.includes("--force");

	// Guard: never touch the production DB unless explicitly forced.
	if (/(^|\/)camhunting\.sqlite$/.test(DB_PATH) && !force) {
		console.error(`Refusing to run against the production DB (${DB_PATH}).`);
		console.error(`Make a copy and set DB_PATH, e.g.:`);
		console.error(`  cp camhunting.sqlite camhunting.fp.sqlite`);
		console.error(`  DB_PATH=camhunting.fp.sqlite bun run fingerprint${apply ? " --apply" : ""}`);
		console.error(`(or pass --force to override).`);
		process.exit(1);
	}

	console.log(`\n── Fingerprint ${apply ? "APPLY" : "dry run"} · ${DB_PATH} ──`);
	const db = openDb();
	try {
		db.run(AUDIT_SCHEMA);

		// ── Webcams ──
		const rows = allRows(db);
		const decisions: Decision[] = [];
		const byRef = new Map<string, Decision>();
		const faviconOf = new Map<string, number>();
		for (const r of rows) {
			let fav: number | null = null;
			try {
				const raw = JSON.parse(r.raw_json) as Record<string, unknown>;
				const f = (((raw.http ?? {}) as Record<string, unknown>).favicon ?? null) as Record<string, unknown> | null;
				if (f && typeof f.hash === "number") fav = f.hash;
			} catch {}
			const d = decideWebcam(r, fingerprintWebcam(r.raw_json));
			decisions.push(d);
			byRef.set(d.ref, d);
			if (fav != null) faviconOf.set(d.ref, fav);
		}
		const faviconApplied = faviconInherit(rows, byRef, faviconOf);

		// Final floor: the whole table is screenshot.label:webcam, so any target still
		// unidentified is a camera of unknown make. Label it honestly at the lowest tier
		// (RTSP rows already floored to "RTSP camera (generic)"; RDP/VNC are not targets).
		let floored = 0;
		for (const d of decisions) {
			if (d.action !== "unknown" || !isServerOrEmpty(d.old)) continue;
			d.next = "Generic IP camera";
			d.tier = "low";
			d.method = "floor";
			d.vendor = "generic";
			d.evidence = "webcam-labeled screenshot; vendor unknown";
			d.action = (d.old ?? "").trim() === "" ? "fill" : "fix-server";
			floored++;
		}
		if (floored) console.log(`Floored ${floored} unidentified target(s) to "Generic IP camera" (low).`);

		// ── Feed ──
		const feed = allFeedRows(db);
		const feedDecisions: Decision[] = [];
		for (const t of feed) {
			const fp = fingerprintFeed(t);
			const old = (t.product ?? null) as string | null;
			if (fp) {
				feedDecisions.push({ kind: "feed", ref: t.id, old, next: fp.product, tier: fp.tier, method: fp.method, vendor: fp.vendor, evidence: fp.evidence, action: (old ?? "").trim() === "" ? "fill" : "upgrade" });
			}
		}

		// ── Write audit (always; rebuilt each run) ──
		db.run("DELETE FROM fingerprints");
		const ins = db.query(
			`INSERT OR REPLACE INTO fingerprints (kind, ref, old_value, new_value, tier, method, vendor, evidence, action)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		db.transaction(() => {
			for (const d of [...decisions, ...feedDecisions]) {
				ins.run(d.kind, d.ref, d.old, d.next, d.tier === "-" ? null : d.tier, d.method, d.vendor === "-" ? null : d.vendor, d.evidence || null, d.action);
			}
		})();

		// ── Apply (optional) ──
		// Both sources write the same column on the same table now: a Decision's `ref`
		// IS the cams id ('ip:port' for cams, feed id for feeds), so one UPDATE covers both.
		if (apply) {
			const up = db.query("UPDATE cams SET product = ? WHERE id = ?");
			const changedCam = db.transaction(() => {
				let n = 0;
				for (const d of decisions) {
					if (d.action === "fill" || d.action === "fix-server" || d.action === "upgrade" || d.action === "normalize") {
						up.run(d.next, d.ref);
						n++;
					}
				}
				return n;
			})();
			const changedFeeds = db.transaction(() => {
				let n = 0;
				for (const d of feedDecisions) {
					up.run(d.next, d.ref);
					n++;
				}
				return n;
			})();
			console.log(`Applied: ${changedCam} cam product update(s), ${changedFeeds} feed product write(s).`);
		}

		report(db, decisions, feedDecisions, faviconApplied, feed.length);
		if (!apply) console.log(`\nDry run. Nothing written to product; review the fingerprints table, then re-run with --apply.`);
	} finally {
		closeDb(db);
	}
}

/** Split an "ip:port" ref, keeping IPv6 colons intact (port is after the last colon). */
function splitRef(ref: string): [string, string] {
	const i = ref.lastIndexOf(":");
	return [ref.slice(0, i), ref.slice(i + 1)];
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function report(db: Database, cam: Decision[], feed: Decision[], faviconApplied: number, feedTotal: number): void {
	const targets = cam.filter((d) => isServerOrEmpty(d.old));
	const solvedTargets = targets.filter((d) => d.action !== "unknown");
	const unknown = targets.filter((d) => d.action === "unknown");

	console.log(`\n=== WEBCAMS (${cam.length} rows) ===`);
	console.log(`Targets (empty or server-name product): ${targets.length}`);
	console.log(`  fingerprinted: ${solvedTargets.length} (${pct(solvedTargets.length, targets.length)})   [favicon-inherited: ${faviconApplied}]`);
	console.log(`  still unknown: ${unknown.length}`);
	console.log(byKey(cam, (d) => d.action, "\nby action:"));
	console.log(byKey(cam.filter((d) => d.tier !== "-"), (d) => d.tier, "\nby tier (rows with a derived label):"));
	console.log(byKey(solvedTargets, (d) => d.method, "\ntargets by method:"));
	console.log(topKey(cam.filter((d) => d.next && d.action !== "keep"), (d) => d.next as string, 30, "\ntop resulting products:"));

	// Single-IP concentration caveat (e.g. the AXIS M3027 decoy on one host).
	const ipCount = new Map<string, number>();
	for (const d of solvedTargets) {
		const [ip] = splitRef(d.ref);
		ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1);
	}
	const topIps = [...ipCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
	console.log(`\ntop IPs by fingerprinted ports (watch for single-host inflation):`);
	for (const [ip, n] of topIps) console.log(`  ${String(n).padStart(4)}  ${ip}`);

	console.log(`\n=== FEEDS (${feedTotal} rows) ===`);
	console.log(`  fingerprinted from live_url: ${feed.length}   (left NULL: ${feedTotal - feed.length}, operator networks)`);
	console.log(topKey(feed, (d) => d.next as string, 15, "\nfeeds products:"));

	// Regression guard: any existing good product that got a strictly less specific label.
	const downgrades = cam.filter((d) => !isServerOrEmpty(d.old) && d.next && d.action === "upgrade" && specificity(d.next) < specificity(canonicalizeExisting(d.old as string)));
	console.log(`\ndowngrades of existing products: ${downgrades.length} (must be 0)`);
	for (const d of downgrades.slice(0, 10)) console.log(`  ${d.ref}: "${d.old}" -> "${d.next}"`);

	console.log(`\nunsolved target sample (title | server | :port):`);
	for (const d of unknown.slice(0, 20)) {
		const row = db.query("SELECT json_extract(raw_json,'$.http.title') t, json_extract(raw_json,'$.http.server') s, port FROM cams WHERE id = ?").get(d.ref) as { t: string | null; s: string | null; port: number } | null;
		if (row) console.log(`  ${(row.t ?? "(no title)").slice(0, 34).padEnd(34)} | ${(row.s ?? "-").slice(0, 22).padEnd(22)} | :${row.port}`);
	}
}

function pct(n: number, d: number): string {
	return d === 0 ? "0%" : `${((100 * n) / d).toFixed(1)}%`;
}

function byKey(rows: Decision[], key: (d: Decision) => string, heading: string): string {
	const c = new Map<string, number>();
	for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
	const lines = [...c.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`);
	return [heading, ...lines].join("\n");
}

function topKey(rows: Decision[], key: (d: Decision) => string, limit: number, heading: string): string {
	const c = new Map<string, number>();
	for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
	const lines = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => `  ${String(n).padStart(5)}  ${k}`);
	return [heading, ...lines].join("\n");
}

// Direct run (`bun run fingerprint`) executes the backfill; importing (e.g. build.ts using
// splitProduct/productBreakdown) must not, so guard on the entry-point check like build.ts.
if (import.meta.main) main();
