import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, countRows, openDb } from "../../src/db.ts";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(async () => {
	space = makeTmpSpace("w3bcam-purge-");
	await prepFixtureDb(space.dbPath);
});
afterEach(() => cleanTmpDir(space.dir));

describe("purge", () => {
	it("removes RDP/VNC cam rows that predate the ingest guard", async () => {
		// Seed a blocked-product cam directly, bypassing the ingest filter.
		{
			const db = openDb(space.dbPath);
			try {
				db.query("INSERT INTO cams (id, kind, feed_kind, product, raw_json) VALUES ('9.9.9.9:5900','cam','screenshot','vnc','{}')").run();
				expect(countRows(db)).toBe(4); // 3 fixture cams + 1 seeded VNC
			} finally {
				closeDb(db);
			}
		}

		const r = await runScript("purge", [], { env: { DB_PATH: space.dbPath } });
		expect(r.code).toBe(0);
		expect(r.output).toContain("1 row(s)");

		const db = openDb(space.dbPath);
		try {
			expect(countRows(db)).toBe(3);
		} finally {
			closeDb(db);
		}
	});
});
