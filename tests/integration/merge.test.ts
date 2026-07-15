import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, countRows, openDb } from "../../src/db/db.ts";
import { prepFixtureDb } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let src: TmpSpace;
let tgt: TmpSpace;
beforeEach(async () => {
	src = makeTmpSpace("w3bcam-merge-src-");
	tgt = makeTmpSpace("w3bcam-merge-tgt-");
	await prepFixtureDb(src.dbPath); // source: 3 cams
	closeDb(openDb(tgt.dbPath)); // target: fresh seeded, 0 cams
});
afterEach(() => {
	cleanTmpDir(src.dir);
	cleanTmpDir(tgt.dir);
});

describe("merge", () => {
	it("--dry-run reports the delta without writing", async () => {
		const r = await runScript("merge", [src.dbPath, tgt.dbPath, "--dry-run"]);
		expect(r.code).toBe(0);
		expect(r.output).toContain("New in source (to add):");

		const db = openDb(tgt.dbPath);
		try {
			expect(countRows(db)).toBe(0);
		} finally {
			closeDb(db);
		}
	});

	it("--yes copies the source's new cams into the target", async () => {
		const r = await runScript("merge", [src.dbPath, tgt.dbPath, "--yes"]);
		expect(r.code).toBe(0);

		const db = openDb(tgt.dbPath);
		try {
			expect(countRows(db)).toBe(3);
		} finally {
			closeDb(db);
		}
	});

	it("exits 1 when a path is missing", async () => {
		expect((await runScript("merge", [src.dbPath])).code).toBe(1);
	});
});
