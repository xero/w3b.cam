import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { closeDb, countFeedRows, countRows, countYtRows, openDb } from "../../src/db/db.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(() => {
	space = makeTmpSpace("w3bcam-initdb-");
});
afterEach(() => cleanTmpDir(space.dir));

describe("initdb", () => {
	it("creates a fresh, seeded DB with the full schema and no cameras", async () => {
		expect(existsSync(space.dbPath)).toBe(false);

		const r = await runScript("initdb", [], { env: { DB_PATH: space.dbPath } });
		expect(r.code).toBe(0);
		expect(r.output).toContain("Initialized");
		expect(r.output).toContain("(0 cameras)");
		expect(existsSync(space.dbPath)).toBe(true);

		const db = openDb(space.dbPath);
		try {
			const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
			expect(tables).toEqual(expect.arrayContaining(["blacklist", "cams", "fingerprints", "host_blacklist", "meta"]));
			expect(countRows(db)).toBe(0);
			expect(countFeedRows(db)).toBe(0);
			expect(countYtRows(db)).toBe(0);
			// Idempotent seeds ran (host blacklist + tag + featured seeds).
			const count = (sql: string) => (db.query(sql).get() as { c: number }).c;
			expect(count("SELECT COUNT(*) AS c FROM host_blacklist")).toBeGreaterThan(0);
			expect(count("SELECT COUNT(*) AS c FROM meta WHERE type='tag'")).toBeGreaterThan(0);
			expect(count("SELECT COUNT(*) AS c FROM meta WHERE type='featured'")).toBeGreaterThan(0);
		} finally {
			closeDb(db);
		}
	});

	it("is idempotent: re-running against an existing DB is a no-op", async () => {
		await runScript("initdb", [], { env: { DB_PATH: space.dbPath } });
		const again = await runScript("initdb", [], { env: { DB_PATH: space.dbPath } });
		expect(again.code).toBe(0);
		expect(again.output).toContain("(0 cameras)");
	});
});
