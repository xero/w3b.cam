// Throwaway temp dirs for a fixture DB + baked site. rmSync(recursive) also clears the
// SQLite -wal / -shm siblings, so nothing leaks between tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir(prefix = "w3bcam-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanTmpDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/** A temp dir plus the conventional db + out paths inside it. */
export interface TmpSpace {
	dir: string;
	dbPath: string;
	outDir: string;
}

export function makeTmpSpace(prefix?: string): TmpSpace {
	const dir = makeTmpDir(prefix);
	return { dir, dbPath: join(dir, "db.sqlite"), outDir: join(dir, "out") };
}
