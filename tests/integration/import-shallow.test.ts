import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BLANK_CREDS, runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

// The import dispatcher's own arg/guard logic is hermetic (it validates before any network
// or DB open). DB_PATH points at a throwaway path purely as a safety net.
let space: TmpSpace;
beforeEach(() => {
	space = makeTmpSpace("w3bcam-import-arg-");
});
afterEach(() => cleanTmpDir(space.dir));
const env = () => ({ DB_PATH: space.dbPath, ...BLANK_CREDS });

describe("import (dispatcher arg/error paths)", () => {
	it("exits 1 when no import type is given", async () => {
		const r = await runScript("import", [], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Pick one import type");
	});

	it("exits 1 when more than one type is given", async () => {
		const r = await runScript("import", ["--shodan", "--youtube"], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Pick exactly one import type");
	});

	it("exits 1 for --youtube without YOUTUBE_API_KEY (before any network)", async () => {
		const r = await runScript("import", ["--youtube"], { env: env() });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Missing required environment variable: YOUTUBE_API_KEY");
	});
});
