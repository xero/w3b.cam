import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, loadSuperFeatures, openDb } from "../../src/db/db.ts";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(async () => {
	space = makeTmpSpace("w3bcam-superfeature-");
	await prepFixtureDb(space.dbPath);
});
afterEach(() => cleanTmpDir(space.dir));

describe("superfeature", () => {
	it("groups feeds under an event key, first listed is primary", async () => {
		const r = await runScript(
			"superfeature",
			["big-event", "mjpeg-38.79.156.188", "butler-oh-129-747"],
			{ env: { DB_PATH: space.dbPath } },
		);
		expect(r.code).toBe(0);

		const db = openDb(space.dbPath);
		try {
			expect(loadSuperFeatures(db).get("big-event")).toEqual(["mjpeg-38.79.156.188", "butler-oh-129-747"]);
		} finally {
			closeDb(db);
		}
	});

	it("exits 1 without a key and at least one feed id", async () => {
		expect((await runScript("superfeature", [], { env: { DB_PATH: space.dbPath } })).code).toBe(1);
	});
});
