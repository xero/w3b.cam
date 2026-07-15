// Shallow coverage for the network-bound scripts. These need Shodan/YouTube credentials,
// ffmpeg, or a live network + external services, so the suite exercises only their
// hermetic arg/guard/error paths (which run offline and deterministically). The run-end
// banner (tests/helpers/coverage-report.ts, via `bun run test`) reports which capabilities
// were absent so the developer knows what was NOT exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { detectCapabilities } from "../helpers/capabilities.ts";
import { BLANK_CREDS, runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

// Opt-in live checks: only when TEST_LIVE=1 AND real creds/network are present. Default
// runs stay fully hermetic (the banner still reports what a live run would need). Set e.g.
//   TEST_LIVE=1 SHODANTOKEN=... bun run test
const caps = await detectCapabilities();
const wantLive = !!process.env.TEST_LIVE;

let space: TmpSpace;
beforeEach(() => {
	space = makeTmpSpace("w3bcam-net-");
});
afterEach(() => cleanTmpDir(space.dir));
const env = () => ({ DB_PATH: space.dbPath, ...BLANK_CREDS });

describe("scrape (needs SHODANTOKEN + network)", () => {
	it("exits 1 without SHODANTOKEN, before any network call", async () => {
		const r = await runScript("scrape", [], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Missing required environment variable: SHODANTOKEN");
	});
});

describe("preflight (needs SHODANTOKEN + network)", () => {
	it("exits 1 without SHODANTOKEN", async () => {
		const r = await runScript("preflight", [], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Missing required environment variable: SHODANTOKEN");
	});

	// Live, opt-in: preflight only READS the credit balance (spends none), so it is the one
	// network path safe to exercise for real. Runs the real SHODANTOKEN (inherited, not blanked).
	it.skipIf(!(wantLive && caps.shodanToken && caps.network))(
		"reports the credit balance with real creds (spends none)",
		async () => {
			const r = await runScript("preflight", []);
			expect(r.code).toBe(0);
			expect(r.output).toContain("Query credits:");
		},
		30_000,
	);
});

describe("sync (needs gh + network)", () => {
	it("exits 1 with no mode selected", async () => {
		const r = await runScript("sync", [], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("A mode is required");
	});

	it("exits 1 on an unknown argument", async () => {
		const r = await runScript("sync", ["--bogus"], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Unknown argument");
	});
});

describe("osiris (needs network + ffmpeg)", () => {
	it("exits non-zero on a missing input file", async () => {
		const missing = join(space.dir, "does-not-exist.json");
		const r = await runScript("osiris", [missing], { env: env() });
		expect(r.code).not.toBe(0);
	});
});
