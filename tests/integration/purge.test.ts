import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, countRows, openDb } from "../../src/db/db.ts";
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
	it("removes RDP/VNC, GIF-screenshot, and decoy-banner cam rows that predate the ingest guards", async () => {
		// Seed one row per guard directly, bypassing the ingest filters.
		{
			const db = openDb(space.dbPath);
			try {
				const ins = db.query("INSERT INTO cams (id, kind, feed_kind, product, ss_base64, raw_json) VALUES (?, 'cam', 'screenshot', ?, ?, ?)");
				ins.run("9.9.9.9:5900", "vnc", null, "{}");
				ins.run("9.9.9.9:8080", "Generic IP camera", "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "{}");
				ins.run("9.9.9.9:12215", "Generic IP camera", null, JSON.stringify({ http: { status: 200, server: "Boa/0.94.14rc21", html: "\n" } }));
				// A real Boa cam (has a body) must survive the decoy purge.
				ins.run("9.9.9.8:80", "Generic IP camera", null, JSON.stringify({ http: { status: 200, server: "Boa/0.94.14rc21", html: "<html>login</html>" } }));
				expect(countRows(db)).toBe(7); // 3 fixture cams + 4 seeded
			} finally {
				closeDb(db);
			}
		}

		const r = await runScript("purge", [], { env: { DB_PATH: space.dbPath } });
		expect(r.code).toBe(0);
		expect(r.output).toContain("3 row(s) (1 RDP/VNC, 1 GIF screenshot, 1 decoy banner)");

		const db = openDb(space.dbPath);
		try {
			expect(countRows(db)).toBe(4); // 3 fixture cams + the real Boa cam
		} finally {
			closeDb(db);
		}
	});
});
