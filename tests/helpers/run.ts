// Run a package.json script as a subprocess and capture its result. We resolve the
// script's actual command from package.json and spawn it directly (e.g. `bun run
// src/curate/tag.ts`) rather than `bun run <name>`: the latter double-spawns (a `bun run` that
// spawns another `bun run`), and under `bun test` the grandchild's piped stdout is
// captured unreliably. Resolving the command still faithfully exercises what the script
// declares (and asserts the script exists). Callers pass DB_PATH / OUT_DIR (and, for the
// shallow tests, blanked credentials) via `env`.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let scriptsCache: Record<string, string> | undefined;
function scripts(): Record<string, string> {
	if (!scriptsCache) {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
		scriptsCache = pkg.scripts ?? {};
	}
	return scriptsCache;
}

/** Resolve a script NAME to its argv (from package.json), or fall back to `bun run <name>`. */
export function resolveCommand(script: string): string[] {
	const cmd = scripts()[script];
	return cmd ? cmd.split(/\s+/) : ["bun", "run", script];
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	/** stdout + stderr, for convenience when asserting on a message wherever it landed. */
	output: string;
}

export interface RunOpts {
	env?: Record<string, string>;
	cwd?: string;
}

export async function runScript(script: string, args: string[] = [], opts: RunOpts = {}): Promise<RunResult> {
	// spawnSync buffers stdout/stderr synchronously — no streaming, so no race with the
	// bun test runner (async pipe capture is flaky there). These CLIs are short one-shots,
	// so blocking is fine; the long-running dev/serve tests use async Bun.spawn instead.
	const res = Bun.spawnSync([...resolveCommand(script), ...args], {
		cwd: opts.cwd ?? REPO_ROOT,
		env: { ...process.env, ...(opts.env ?? {}) },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = res.stdout?.toString() ?? "";
	const stderr = res.stderr?.toString() ?? "";
	return { code: res.exitCode ?? -1, stdout, stderr, output: stdout + stderr };
}

/**
 * Env that blanks the network credentials so a script hits its "missing required env var"
 * guard deterministically, regardless of a populated local .env. Bun does not let an .env
 * value override a variable already present in the environment, and mustEnv() treats an
 * empty string as missing.
 */
export const BLANK_CREDS: Record<string, string> = {
	SHODANTOKEN: "",
	YOUTUBE_API_KEY: "",
};
