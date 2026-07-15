// Fingerprint: derive the real camera device (vendor + model where possible) from a
// stored Shodan banner or a feed URL, and write it to the `product` field the site
// renders as "Fingerprint" (see render.ts). Shodan's own `product` is a mixed bag —
// often empty, often just the web server (`Apache httpd`, `nginx`, `Boa`) rather than
// the camera. This mines the full banner (http.title, the `hikvision` block, cpe23,
// http.server, http.html path fragments, and the RTSP `data` banner) through an ordered
// cascade, highest-confidence signal first.
//
// This module is a PURE LEAF (it imports only ./types.ts): the classifiers
// (fingerprintWebcam / fingerprintFeed) and the anti-downgrade decision (decideCamProduct)
// run at ingestion time — db.ts wires them into the cam/feed upserters, so `product` and
// the `fingerprints` audit row are correct at insert. The catch-up backfill that re-derives
// the whole table on demand (e.g. after adding a rule) lives in src/fingerprint-cli.ts.

import type { ProductGroup } from "./types.ts";

// ── Result shape ────────────────────────────────────────────────────────────────

/** Confidence in a derived fingerprint. `high` = exact model / vendor from a direct
 * self-report (title, hik block, cpe, distinctive server); `medium` = vendor family
 * from an endpoint path or RTSP server; `low` = a generic floor label. */
export type Tier = "high" | "medium" | "low";

export interface FpResult {
	/** The label written to `product`, e.g. "Axis M3027" or "Dahua-family (RTSP)". */
	product: string;
	/** Coarse vendor/family key for aggregation (per-vendor galleries, reporting). */
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
	hik: boolean;
	cpe: string; // cpe23 joined lowercase
}

/** Pull the fields the cascade reads out of a parsed Shodan match object. */
function signalsFrom(raw: Record<string, unknown>): Signals {
	const http = (raw.http ?? {}) as Record<string, unknown>;
	const cpe23 = raw.cpe23;
	return {
		title: str(http.title),
		server: str(http.server),
		html: str(http.html),
		data: str(raw.data),
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
	// Axis: "AXIS M1113 Network Camera", "AXIS Q1755", "Axis 2100 Network Camera", bare "AXIS".
	// Case-insensitive: older firmware uses mixed case ("Axis 2100"); normalize the model to upper.
	if ((m = t.match(/\bAXIS\s+([A-Za-z]?\d{3,4}[A-Za-z0-9-]*)/i))) return hit(`Axis ${(m[1] ?? "").toUpperCase()}`, "axis");
	if (/^AXIS\b/i.test(t)) return hit("Axis (model unknown)", "axis");
	// Sony: "Sony Network Camera SNC-RZ30", bare "SNC-CH110" — the SNC- prefix names the model.
	if ((m = t.match(/\b(SNC-[A-Z0-9]+)\b/i))) return hit(`Sony ${(m[1] ?? "").toUpperCase()}`, "sony");
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
	// StarDot: title is "<model> Live Image" — NetCam SC/SCX/XL/LIVE, ExpressXL. Capture the model token.
	if ((m = t.match(/^(NetCam[A-Z0-9]*|Express[A-Z0-9]*)\s+Live Image$/i))) {
		const mdl = (m[1] ?? "").replace(/^NetCam(?=[A-Za-z0-9])/i, "NetCam ");
		return hit(`StarDot ${mdl}`, "stardot");
	}
	// Intelbras (Dahua OEM, Brazil).
	if (/^INTELBRAS/i.test(t)) return hit("Intelbras", "intelbras");
	// IQinVision / IQeye: title names the model, e.g. "IQeye511DV ...", "IQeye755 ...".
	if ((m = t.match(/\b(IQeye\d+[A-Z]*)\b/i))) return hit(`IQinVision ${m[1]}`, "iqinvision");
	// Blue Iris NVR software (Windows) aggregating cameras behind a web UI.
	if (/Blue Iris/i.test(t)) return hit("Blue Iris (NVR software)", "blueiris");
	// Toshiba network cameras: "TOSHIBA Network Camera - User Login".
	if (/^TOSHIBA\b/i.test(t)) return hit("Toshiba", "toshiba");
	// Blue Iris UI3 web client titles each server "<name> UI3" (server is BlueServer; see fromServer).
	if (/(?:^|\s)UI3$/.test(t)) return hit("Blue Iris (NVR software)", "blueiris");
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
	// Blue Iris's bundled web server reports "BlueServer/<ver>" (not "blueiris").
	if (l.startsWith("blueserver") || l.startsWith("blueiris")) return hit("Blue Iris (NVR software)", "blueiris", "high");
	// Sony network cameras: "NetEVI/<ver>" server (model comes from the SNC- title when present).
	if (l.startsWith("netevi")) return hit("Sony (model unknown)", "sony", "high");
	// Android "IP Webcam" app.
	if (l.startsWith("ip webcam server")) return hit("Android IP Webcam", "ipwebcam", "high");
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
	{ re: /nphmotionjpeg|cgistart\?page=|cgitagmenu|barfoot\.html/i, product: "Panasonic/i-PRO", vendor: "panasonic" },
	{ re: /getmjstream|cgistream\.cgi/i, product: "Foscam", vendor: "foscam" },
	// Vivotek self-brands its web UI ("Powered by VIVOTEK" / VVTK namespace / vivotek.com logo link).
	{ re: /updatePowerByVVTKLogo|\bVVTK\b|vivotek/i, product: "Vivotek", vendor: "vivotek" },
	// Dahua web UI: RPC2 login SDK (rpcCore.js / RPC2_Login / ptzCtrl.js), often titled "WEB SERVICE".
	{ re: /rpcCore\.js|RPC2_Login|ptzCtrl\.js/i, product: "Dahua-family", vendor: "dahua" },
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

// ── <meta name="description"> model self-report ──────────────────────────────────

/**
 * Some OEM camera firmwares put the bare model number in the page's meta description
 * (e.g. `<meta name="description" content="WVC80N">`), even when the visible title is a
 * broken JS template. Only prefixes that map unambiguously to one vendor are trusted;
 * the exact model is carried through verbatim.
 */
const META_MODELS: { re: RegExp; make: string; vendor: string }[] = [
	{ re: /^WVC\d[A-Z0-9]*/i, make: "Linksys", vendor: "linksys" }, // Linksys/Cisco WVC "Wireless Video Camera" line
	{ re: /^FCS-\d[A-Z0-9]*/i, make: "LevelOne", vendor: "levelone" }, // LevelOne FCS IP cameras
];

function fromMeta(html: string): FpResult | null {
	if (!html) return null;
	const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
	const content = m && m[1] ? m[1].trim() : "";
	if (!content) return null;
	for (const r of META_MODELS) {
		const mm = content.match(r.re);
		if (mm) return { product: `${r.make} ${mm[0].toUpperCase()}`, vendor: r.vendor, method: "meta-desc", tier: "high", evidence: `meta description "${content.slice(0, 60)}"` };
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
 * then vendor blocks, then endpoint paths, then RTSP servers, then a generic floor). The
 * anti-downgrade decision and the final "Generic IP camera" floor live in decideCamProduct.
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

	// 4b. Exact model self-reported in the meta description (before the weaker path fragments).
	const byMeta = fromMeta(sig.html);
	if (byMeta) return byMeta;

	// 5. HTML endpoint path fragments.
	const byHtml = fromHtml(sig.html);
	if (byHtml) return byHtml;

	// 6/7. RTSP or HTTP `data` banner.
	const byData = fromData(sig.data);
	if (byData) return byData;

	// 8. Generic title floor.
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
export function canonicalizeExisting(p: string): string {
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
export function specificity(label: string): number {
	if (GENERIC_LABELS.has(label)) return 1;
	// Treat H264/H265 as codec noise, not a model number, before the digit test.
	const cleaned = label.replace(/h\.?26[45]/gi, "");
	if (/\d{2,}/.test(cleaned)) return 3;
	return 2;
}

// ── The ingest decision (anti-downgrade + floor) ──────────────────────────────────

/** What decideCamProduct decided to do, relative to the existing product. */
export type Action = "fill" | "fix-server" | "upgrade" | "normalize" | "keep";

/** The product to store for one webcam plus the audit fields that describe how it was derived. */
interface CamDecision {
	/** The product to write to `cams.product`. */
	product: string;
	tier: Tier | "-";
	method: string;
	/** Coarse vendor key for the audit / per-vendor galleries ("-" when unknown). */
	vendor: string;
	evidence: string;
	action: Action;
}

/**
 * Decide the product to store for one webcam given its existing product and a fresh cascade
 * result, and record which signal drove it. This is the anti-downgrade brain shared by the
 * ingest path (db.ts) and the catch-up backfill (fingerprint-cli.ts):
 *   - an empty or server-name product always re-derives (fill / fix-server),
 *   - a real product upgrades only on a high-tier equal-or-more-specific hit, and a generic
 *     floor upgrades on ANY strictly-more-specific hit (so a medium-tier vendor signal on a
 *     later run wins an already-floored row), else it is normalized or kept,
 *   - a target left unidentified is floored to "Generic IP camera" at the lowest tier
 *     (all Shodan cams are webcam-labeled screenshots, so an unknown one is a camera of
 *     unknown make; RDP/VNC never reach here — they are filtered before ingest).
 * The fresh fp's vendor threads into EVERY outcome (even keep/normalize) so the audit's
 * vendor tracks the device, not just the rows that changed.
 */
export function decideCamProduct(oldProduct: string | null, fp: FpResult | null): CamDecision {
	const old = oldProduct;
	const base = { vendor: fp?.vendor ?? "-", evidence: fp?.evidence ?? "" };

	if (isServerOrEmpty(old)) {
		const action: Action = (old ?? "").trim() === "" ? "fill" : "fix-server";
		// Target row: take any tier the cascade produced, else floor.
		if (fp) return { ...base, product: fp.product, tier: fp.tier, method: fp.method, action };
		return { product: "Generic IP camera", tier: "low", method: "floor", vendor: "generic", evidence: "webcam-labeled screenshot; vendor unknown", action };
	}

	// Existing product: normalize, and upgrade on either
	//  - a high-tier hit that is equal-or-more-specific (a better model self-report), or
	//  - ANY strictly-more-specific hit when the current label is only a generic floor.
	const canon = canonicalizeExisting(old as string);
	const oldIsFloor = GENERIC_LABELS.has(canon);
	if (
		fp && fp.product !== old &&
		((fp.tier === "high" && specificity(fp.product) >= specificity(canon)) ||
			(oldIsFloor && specificity(fp.product) > specificity(canon)))
	) {
		return { ...base, product: fp.product, tier: fp.tier, method: fp.method, action: "upgrade" };
	}
	if (canon !== old) return { ...base, product: canon, tier: "-", method: "canon", action: "normalize" };
	return { ...base, product: old as string, tier: "-", method: "kept", action: "keep" };
}

// ── Make / model split for the fingerprints-page breakdown ─────────────────────────

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
	"Sony", "Linksys", "LevelOne", "Toshiba",
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
	// "(model unknown)" is make-known/model-unknown — same state as a bare make, so render it
	// as the shared "—" row rather than a separate "unknown" row (keeps every make consistent).
	if (/^model unknown$/i.test(m)) return null;
	if (/^ip camera$/i.test(m)) return null;
	return m === "" ? null : m;
}

/**
 * Split a product fingerprint into a display make and model for the breakdown table.
 * The label vocabulary is closed (this file emits it), so this is a lookup, not a guess;
 * anything unrecognized falls to make "Other" with the whole label as the model.
 */
function splitProduct(product: string): { make: string; model: string | null } {
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
interface BreakdownEntry {
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
