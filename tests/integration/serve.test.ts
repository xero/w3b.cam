import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { serveStatic } from "../../src/serve.ts";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { resolveCommand, runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

const PORT = 13731;
const base = `http://localhost:${PORT}`;
let space: TmpSpace;
let server: Subprocess | undefined;

async function waitForServer(timeoutMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const r = await fetch(base, { redirect: "manual" });
			if (r.status === 200 || r.status === 404) return;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("serve did not become ready");
}

beforeAll(async () => {
	space = makeTmpSpace("w3bcam-serve-");
	await prepFixtureDb(space.dbPath);
	const baked = await runScript("bake", [], { env: { DB_PATH: space.dbPath, OUT_DIR: space.outDir } });
	if (baked.code !== 0) throw new Error(`bake failed:\n${baked.output}`);

	// Long-running server: async spawn (not the synchronous runScript), killed in afterAll.
	server = Bun.spawn(resolveCommand("serve"), {
		env: { ...process.env, OUT_DIR: space.outDir, PORT: String(PORT) },
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	await waitForServer(8000);
});

afterAll(() => {
	server?.kill();
	cleanTmpDir(space.dir);
});

describe("serve (static file server)", () => {
	it("serves the homepage", async () => {
		const r = await fetch(base);
		expect(r.status).toBe(200);
		expect(await r.text()).toContain("<main");
	});

	it("resolves clean folder URLs to index.html for each kind", async () => {
		for (const route of ["/gallery/1", "/hosts/160.72.56.179", "/streams/yt-Yw8CZCEOdXE", "/feeds/38.79.156.188"]) {
			const r = await fetch(base + route);
			expect(r.status).toBe(200);
		}
	});

	it("serves the co-located snippet for a route", async () => {
		const r = await fetch(`${base}/hosts/160.72.56.179/index.snippet.html`);
		expect(r.status).toBe(200);
	});

	it("404s an unknown route", async () => {
		expect((await fetch(`${base}/no/such/page`)).status).toBe(404);
	});

	it("403s a path-traversal attempt", async () => {
		// Tested in-process: fetch/URL normalize a bare `..` away before it reaches the
		// server. Encoding the slashes (%2f) stops the URL parser treating the dots as
		// path segments, so the payload survives parsing and decodes to `../../etc/passwd`,
		// which serveStatic's `includes("..")` guard rejects before any filesystem access.
		const res = await serveStatic(new Request("http://localhost/%2e%2e%2f%2e%2e%2fetc%2fpasswd"));
		expect(res.status).toBe(403);
	});
});
