import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { closeDb, openDb } from "../../src/db/db.ts";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(async () => {
	space = makeTmpSpace("w3bcam-fp-");
	await prepFixtureDb(space.dbPath);
});
afterEach(() => cleanTmpDir(space.dir));

describe("fingerprint (backfill CLI)", () => {
	it("rebuilds the fingerprints audit table on a dry run", async () => {
		const r = await runScript("fingerprint", [], { env: { DB_PATH: space.dbPath } });
		expect(r.code).toBe(0);
		expect(r.output.toLowerCase()).toContain("dry run");

		const db = openDb(space.dbPath);
		try {
			const n = (db.query("SELECT COUNT(*) AS c FROM fingerprints").get() as { c: number }).c;
			expect(n).toBeGreaterThan(0);
		} finally {
			closeDb(db);
		}
	});

	it("--apply writes cams.product", async () => {
		const r = await runScript("fingerprint", ["--apply"], { env: { DB_PATH: space.dbPath } });
		expect(r.code).toBe(0);
		expect(r.output).toContain("Applied:");
	});

	it("refuses to run against a production camhunting.sqlite path without --force", async () => {
		const prodPath = join(space.dir, "camhunting.sqlite");
		const r = await runScript("fingerprint", [], { env: { DB_PATH: prodPath } });
		expect(r.code).toBe(1);
		expect(r.output).toContain("Refusing to run against the production DB");
	});
});
