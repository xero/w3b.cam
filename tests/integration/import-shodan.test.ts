import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, countRows, hasHost, openDb } from "../../src/db.ts";
import { SHODAN_FIXTURE_DIR } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(() => {
	space = makeTmpSpace("w3bcam-import-");
});
afterEach(() => cleanTmpDir(space.dir));

const importShodan = () => runScript("import", ["--shodan", SHODAN_FIXTURE_DIR], { env: { DB_PATH: space.dbPath } });

describe("import --shodan (hermetic: screenshots are embedded base64)", () => {
	it("ingests valid cams and drops RDP/VNC + no-screenshot banners", async () => {
		const r = await importShodan();
		expect(r.code).toBe(0);
		expect(r.output).toContain("New cameras added: 3");
		expect(r.output).toContain("rdp/vnc skipped");
		expect(r.output).toContain("no screenshot");

		const db = openDb(space.dbPath);
		try {
			expect(countRows(db)).toBe(3);
			expect(hasHost(db, "160.72.56.179")).toBe(true); // valid, 2 ports
			expect(hasHost(db, "149.232.130.7")).toBe(true); // valid
			expect(hasHost(db, "203.0.113.9")).toBe(false); // VNC -> dropped
			expect(hasHost(db, "198.51.100.7")).toBe(false); // no screenshot -> dropped
			// Every stored cam has baked image bytes, so it will actually render.
			const noImg = (db.query("SELECT COUNT(*) AS c FROM cams WHERE kind='cam' AND ss_base64 IS NULL").get() as { c: number }).c;
			expect(noImg).toBe(0);
		} finally {
			closeDb(db);
		}
	});

	it("is idempotent: re-import refreshes rather than duplicating", async () => {
		await importShodan();
		const second = await importShodan();
		expect(second.code).toBe(0);
		const db = openDb(space.dbPath);
		try {
			expect(countRows(db)).toBe(3);
		} finally {
			closeDb(db);
		}
	});
});
