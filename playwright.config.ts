import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One throwaway workspace per run: global-setup preps a fixture DB + bakes the site into
// it, the webServer serves it, global-teardown removes it. Fixed path so setup, server, and
// teardown agree within a run.
export const E2E_ROOT = join(tmpdir(), "w3bcam-e2e");
export const E2E_DB = join(E2E_ROOT, "db.sqlite");
export const E2E_OUT = join(E2E_ROOT, "out");

const PORT = Number(process.env.E2E_PORT ?? 1337);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "./tests/e2e",
	testMatch: "**/*.e2e.ts",
	globalTeardown: "./tests/e2e/global-teardown.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? "line" : [["list"], ["html", { open: "never" }]],
	use: { baseURL: BASE_URL, trace: "on-first-retry" },
	webServer: {
		// Prep the fixture DB + bake into E2E_OUT, THEN serve it — one command so the site is
		// always built before Playwright's readiness probe hits `/` (order-independent).
		command: "bun run tests/helpers/prep-fixture.ts && bun run serve",
		url: BASE_URL,
		env: { DB_PATH: E2E_DB, OUT_DIR: E2E_OUT, PORT: String(PORT) },
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: "**/no-js.e2e.ts" },
		{ name: "no-js", use: { ...devices["Desktop Chrome"], javaScriptEnabled: false }, testMatch: "**/no-js.e2e.ts" },
	],
});
