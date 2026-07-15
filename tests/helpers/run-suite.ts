// Wrapper for the primary `bun test` flow: run the unit + integration suites, then ALWAYS
// print the coverage-gaps banner, while preserving bun test's real exit code (so a genuine
// failure still fails the run, but the banner shows either way and lands last).

import { join, resolve } from "node:path";
import { printCoverageBanner } from "./coverage-report.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

// Absolute paths: bun test resolves them independently of cwd, and it avoids a sandbox
// quirk where relative test paths can break child-process spawning inside a test.
const proc = Bun.spawn(["bun", "test", join(REPO_ROOT, "tests/unit"), join(REPO_ROOT, "tests/integration")], {
	cwd: REPO_ROOT,
	env: { ...process.env },
	stdout: "inherit",
	stderr: "inherit",
	stdin: "inherit",
});
const code = await proc.exited;

await printCoverageBanner();

process.exit(code);
