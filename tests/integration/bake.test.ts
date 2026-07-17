import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;

beforeAll(async () => {
	space = makeTmpSpace("w3bcam-bake-");
	await prepFixtureDb(space.dbPath);
	const r = await runScript("bake", [], { env: { DB_PATH: space.dbPath, OUT_DIR: space.outDir } });
	if (r.code !== 0) throw new Error(`bake failed (code ${r.code}):\n${r.output}`);
});
afterAll(() => cleanTmpDir(space.dir));

const p = (rel: string) => join(space.outDir, rel);
const read = (rel: string) => readFileSync(p(rel), "utf8");

describe("bake output", () => {
	it("writes the homepage, its snippet, and the core assets", () => {
		for (const f of ["index.html", "index.snippet.html", "style.css", "app.js", "hls.min.js", "crt.css", "ms_sans_serif.woff2", "ms_sans_serif_bold.woff2", "rss.xml", "atom.xml", "icons.svg"]) {
			expect(existsSync(p(f))).toBe(true);
		}
	});

	it("vendors the map libs on-demand and copies the geo data recursively", () => {
		// d3 + topojson-client are kept OUT of app.js and fetched only on the map page (like
		// hls.js), and the committed vector data (a nested tree) lands under out/geo/.
		for (const f of ["d3.min.js", "topojson-client.min.js", "geo/world.json", "geo/admin1/USA.json"]) {
			expect(existsSync(p(f))).toBe(true);
		}
	});

	it("bundles all client JS into one app.js and ships no standalone client scripts", () => {
		// The page pulls a single script; hls.js is the one intentional exception (on-demand).
		expect(read("index.html")).toContain('<script src="/app.js" defer></script>');
		expect(read("index.html")).not.toMatch(/src="\/(htmx\.min|feeds|map|geomap|live-lifecycle|theme|crt-config)\.js"/);
		for (const gone of ["htmx.min.js", "feeds.js", "map.js", "geomap.js", "live-lifecycle.js", "theme.js", "crt-config.js"]) {
			expect(existsSync(p(gone))).toBe(false);
		}
		// app.js actually carries htmx + each of our scripts (incl. geomap), concatenated.
		const app = read("app.js");
		for (const marker of ["htmx", "window.liveLifecycle", "data-refresh", "worldmap-canvas", "window.__CRT", "themeSel"]) {
			expect(app).toContain(marker);
		}
	});

	it("writes a landing + detail page for each kind, plus tags/fingerprints/event/map/tips", () => {
		const routes = [
			"hosts/160.72.56.179/index.html", // cam detail
			"streams/yt-Yw8CZCEOdXE/index.html", // stream detail
			"feeds/38.79.156.188/index.html", // feed detail (mjpeg- prefix stripped)
			"gallery/1/index.html",
			"hosts/1/index.html",
			"streams/1/index.html",
			"feeds/1/index.html",
			"tags/index.html",
			"tags/graffiti/index.html",
			"fingerprints/index.html",
			"fingerprints/hikvision/index.html",
			"event/test-event/index.html",
			"map/index.html",
			"tips/index.html",
		];
		for (const f of routes) expect(existsSync(p(f))).toBe(true);
	});

	it("route duality: each snippet equals the full page's <main> inner (modulo shell indent)", () => {
		for (const route of ["", "hosts/160.72.56.179", "streams/yt-Yw8CZCEOdXE", "feeds/38.79.156.188"]) {
			const full = read(route === "" ? "index.html" : `${route}/index.html`);
			const snip = read(route === "" ? "index.snippet.html" : `${route}/index.snippet.html`);
			const m = full.match(/<main[^>]*>([\s\S]*)<\/main>/);
			if (!m) throw new Error(`no <main> in ${route || "home"}`);
			const inner = (m[1] ?? "").split("\n").map((l) => l.replace(/^\t\t\t/, "")).join("\n").trim();
			expect(inner).toBe(snip.trim());
		}
	});

	it("a host with a mined live_url joins the mjpeg auto-tag and renders a click-to-load facade", () => {
		// 149.232.130.7's fixture banner advertises an MJPEG path over https, so the ingest hook
		// derives its live_url — putting it under the `mjpeg` tag beside the feed cams, and
		// swapping its host-page screenshot for the shared click-to-load facade.
		expect(existsSync(p("tags/mjpeg/index.html"))).toBe(true);
		expect(read("tags/mjpeg/index.html")).toContain("/hosts/149.232.130.7");
		const host = read("hosts/149.232.130.7/index.html");
		expect(host).toContain('class="facade"');
		expect(host).toContain('<template class="facade-media">');
	});

	it("production HTML carries no dev-only data-* hooks", () => {
		for (const f of ["index.html", "feeds/38.79.156.188/index.html", "hosts/160.72.56.179/index.html"]) {
			expect(read(f)).not.toMatch(/data-(kind|ref|port)=/);
		}
	});

	it("the shell nav has all 8 section links", () => {
		const home = read("index.html");
		for (const route of ["/gallery", "/hosts", "/feeds", "/streams", "/fingerprints", "/tags", "/map", "/tips"]) {
			expect(home).toContain(`href="${route}"`);
		}
	});

	it("extracts content-hashed screenshots that the pages reference", () => {
		expect(existsSync(p("img"))).toBe(true);
		const refs = [...read("index.html").matchAll(/\/img\/[A-Za-z0-9]+\.[a-z0-9]+/g)].map((m) => m[0]);
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs.slice(0, 5)) expect(existsSync(p(ref.replace(/^\//, "")))).toBe(true);
	});
});
