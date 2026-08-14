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

describe("unsuperfeature", () => {
	const env = () => ({ env: { DB_PATH: space.dbPath } });
	const group = () => {
		const db = openDb(space.dbPath);
		try {
			return loadSuperFeatures(db).get("big-event");
		} finally {
			closeDb(db);
		}
	};
	beforeEach(async () => {
		await runScript("superfeature", ["big-event", "mjpeg-38.79.156.188", "butler-oh-129-747"], { env: { DB_PATH: space.dbPath } });
	});

	it("removes the entire event when given only the key", async () => {
		expect(group()).toEqual(["mjpeg-38.79.156.188", "butler-oh-129-747"]);
		const r = await runScript("unsuperfeature", ["big-event"], env());
		expect(r.code).toBe(0);
		expect(group()).toBeUndefined(); // whole group gone
	});

	it("drops only the named feed(s), leaving the rest of the group", async () => {
		const r = await runScript("unsuperfeature", ["big-event", "butler-oh-129-747"], env());
		expect(r.code).toBe(0);
		expect(group()).toEqual(["mjpeg-38.79.156.188"]); // primary survives
	});

	it("warns (but exits 0) on an unknown event key, and exits 1 with no key", async () => {
		const unknown = await runScript("unsuperfeature", ["no-such-event"], env());
		expect(unknown.code).toBe(0);
		expect(unknown.output).toContain("No super-feature group");
		expect((await runScript("unsuperfeature", [], env())).code).toBe(1);
	});
});
