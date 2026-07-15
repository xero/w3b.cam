// Bun entry: prep the fixture DB, then bake the site. Both targets come from the
// environment (src/core/config.ts reads DB_PATH / OUT_DIR at startup), so this fresh process
// picks them up correctly. Reused by Playwright global-setup and the bake integration test:
//
//   DB_PATH=<tmp>/db.sqlite OUT_DIR=<tmp>/out bun run tests/helpers/prep-fixture.ts

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "../../src/site/build.ts";
import { DB_PATH, OUT_DIR } from "../../src/core/config.ts";
import { prepFixtureDb } from "./fixture.ts";

if (import.meta.main) {
	// Clean slate: ensure the parent dir exists and drop any stale DB (build() wipes OUT_DIR).
	mkdirSync(dirname(DB_PATH), { recursive: true });
	for (const suffix of ["", "-wal", "-shm"]) rmSync(DB_PATH + suffix, { force: true });
	await prepFixtureDb(DB_PATH);
	await build();
	console.log(`fixture ready: DB=${DB_PATH} OUT=${OUT_DIR}`);
}
