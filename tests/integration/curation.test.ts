import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDb, entityTags, hasHost, isFeatured, loadYtGeo, openDb } from "../../src/db.ts";
import { prepFixtureDb, SHODAN_FIXTURE_DIR } from "../helpers/fixture.ts";
import { runScript } from "../helpers/run.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";

let space: TmpSpace;
beforeEach(async () => {
	space = makeTmpSpace("w3bcam-curation-");
	await prepFixtureDb(space.dbPath);
});
afterEach(() => cleanTmpDir(space.dir));

const env = () => ({ DB_PATH: space.dbPath });
function withDb<T>(fn: (db: Database) => T): T {
	const db = openDb(space.dbPath);
	try {
		return fn(db);
	} finally {
		closeDb(db);
	}
}

describe("tag / untag", () => {
	it("adds then removes a tag on a cam", async () => {
		const add = await runScript("tag", ["cam", "149.232.130.7", "nightview"], { env: env() });
		expect(add.code).toBe(0);
		expect(withDb((db) => entityTags(db, "cam", "149.232.130.7"))).toContain("nightview");

		const rm = await runScript("untag", ["cam", "149.232.130.7", "nightview"], { env: env() });
		expect(rm.code).toBe(0);
		expect(withDb((db) => entityTags(db, "cam", "149.232.130.7"))).not.toContain("nightview");
	});

	it("rejects an invalid kind and a non-IP cam ref", async () => {
		expect((await runScript("tag", ["bogus", "x", "y"], { env: env() })).code).toBe(1);
		const badIp = await runScript("tag", ["cam", "not-an-ip", "y"], { env: env() });
		expect(badIp.code).toBe(1);
		expect(badIp.output).toContain("Invalid IP");
	});
});

describe("feature / unfeature", () => {
	it("pins then unpins a stream (aBcDeFgHiJk is not seed-featured)", async () => {
		expect(withDb((db) => isFeatured(db, "stream", "aBcDeFgHiJk"))).toBe(false);
		expect((await runScript("feature", ["stream", "aBcDeFgHiJk"], { env: env() })).code).toBe(0);
		expect(withDb((db) => isFeatured(db, "stream", "aBcDeFgHiJk"))).toBe(true);
		expect((await runScript("unfeature", ["stream", "aBcDeFgHiJk"], { env: env() })).code).toBe(0);
		expect(withDb((db) => isFeatured(db, "stream", "aBcDeFgHiJk"))).toBe(false);
	});
});

describe("blacklist / unblacklist", () => {
	it("blacklist deletes a host's cams and blocks re-ingest; unblacklist lifts it", async () => {
		expect(withDb((db) => hasHost(db, "160.72.56.179"))).toBe(true);

		const bl = await runScript("blacklist", ["160.72.56.179"], { env: env() });
		expect(bl.code).toBe(0);
		expect(bl.output).toContain("Deleted:");
		expect(withDb((db) => hasHost(db, "160.72.56.179"))).toBe(false);

		// Re-ingesting the same fixture must NOT bring a blacklisted host back.
		await runScript("import", ["--shodan", SHODAN_FIXTURE_DIR], { env: env() });
		expect(withDb((db) => hasHost(db, "160.72.56.179"))).toBe(false);

		// Lift the block, re-ingest, and it returns.
		expect((await runScript("unblacklist", ["160.72.56.179"], { env: env() })).code).toBe(0);
		await runScript("import", ["--shodan", SHODAN_FIXTURE_DIR], { env: env() });
		expect(withDb((db) => hasHost(db, "160.72.56.179"))).toBe(true);
	});

	it("exits 1 with no argument", async () => {
		expect((await runScript("blacklist", [], { env: env() })).code).toBe(1);
	});
});

describe("remove", () => {
	it("deletes a cam without blacklisting (re-ingest restores it)", async () => {
		expect(withDb((db) => hasHost(db, "149.232.130.7"))).toBe(true);
		const rm = await runScript("remove", ["149.232.130.7"], { env: env() });
		expect(rm.code).toBe(0);
		expect(withDb((db) => hasHost(db, "149.232.130.7"))).toBe(false);

		await runScript("import", ["--shodan", SHODAN_FIXTURE_DIR], { env: env() });
		expect(withDb((db) => hasHost(db, "149.232.130.7"))).toBe(true);
	});
});

describe("reorder", () => {
	it("pins a host's preferred port, then clears it", async () => {
		const set = await runScript("reorder", ["160.72.56.179", "81"], { env: env() });
		expect(set.code).toBe(0);
		expect(
			withDb((db) => (db.query("SELECT port FROM cams WHERE ip_str = ? AND preferred = 1").get("160.72.56.179") as { port: number } | null)?.port),
		).toBe(81);

		const clear = await runScript("reorder", ["160.72.56.179", "--clear"], { env: env() });
		expect(clear.code).toBe(0);
		expect(
			withDb((db) => (db.query("SELECT COUNT(*) AS c FROM cams WHERE ip_str = ? AND preferred = 1").get("160.72.56.179") as { c: number }).c),
		).toBe(0);
	});
});

describe("geo", () => {
	it("assigns coordinates to a stream", async () => {
		expect(withDb((db) => loadYtGeo(db).has("aBcDeFgHiJk"))).toBe(false);
		const g = await runScript("geo", ["aBcDeFgHiJk", "35.5", "139.7"], { env: env() });
		expect(g.code).toBe(0);
		expect(withDb((db) => loadYtGeo(db).get("aBcDeFgHiJk"))).toEqual({ lat: 35.5, lng: 139.7 });
	});

	it("rejects out-of-range coordinates", async () => {
		expect((await runScript("geo", ["aBcDeFgHiJk", "999", "0"], { env: env() })).code).toBe(1);
	});
});
