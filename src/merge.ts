// Merge: copy new webcam rows from one SQLite DB into another, keyed on
// (ip_str, port). Finds the cameras present in the SOURCE's `webcams` table but
// missing from the TARGET's, and inserts only those — verbatim, preserving
// first_seen / last_seen / preferred. Rows the target already has are left
// completely untouched (this is not an upsert), so your local pins, tags, and
// curation on shared cameras survive. Purely local: no gh, no network, no
// whole-file copy. Only the target's `webcams` table is written, and only after
// you confirm; the source is opened read-only.
//
// The typical use: after `bun sync --pull` drops a fresh prod copy beside your
// local DB, fold prod's newly-scraped cameras into your local one without losing
// unpushed work.
//
// Usage:
//   bun run merge <source-db> <target-db>            add source's new cams to target
//   bun run merge <source-db> <target-db> --dry-run  preview the delta, write nothing
//   bun run merge <source-db> <target-db> --yes      skip the confirmation prompt (-y)

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { closeDb, countRows } from "./db.ts";

const USAGE = "Usage: bun run merge <source-db> <target-db> [--dry-run] [--yes]";

// ── Helpers ─────────────────────────────────────────────────────────────────
/** A camera's identity plus enough to preview it. `country_name` is display-only. */
interface KeyRow {
  ip_str: string;
  port: number;
  country_name: string | null;
}

/** Composite primary key as a string. ip_str never contains a space, so this can't collide. */
const keyOf = (r: { ip_str: string; port: number }): string => `${r.ip_str} ${r.port}`;

/** The `webcams` column names, in declared order. Empty if the table doesn't exist. */
function webcamColumns(db: Database): string[] {
  return (db.query("PRAGMA table_info(webcams)").all() as { name: string }[]).map((c) => c.name);
}

/** Columns present in BOTH tables (source order), so a schema drift can't break the copy. */
function commonColumns(source: Database, target: Database): string[] {
  const inTarget = new Set(webcamColumns(target));
  return webcamColumns(source).filter((c) => inTarget.has(c));
}

/**
 * Open a database strictly read-only, never modifying it. A plain read-only open
 * fails on a WAL-mode DB with no -wal/-shm sidecars (e.g. a freshly `sync --pull`ed,
 * checkpointed snapshot): SQLite can't create the shared-memory index read-only. Fall
 * back to an immutable URI, which promises the file won't change so SQLite reads the
 * main file directly with no sidecars and no writes. The first attempt still wins for
 * non-WAL DBs or ones whose sidecars already exist (so a live WAL is respected). Bun
 * opens lazily, so force a read to surface the WAL failure before returning the handle.
 */
function openReadonly(path: string): Database {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    db.query("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    return db;
  } catch {
    db?.close();
    return new Database(`file:${resolve(path)}?immutable=1`, { readonly: true, strict: true });
  }
}

/** Prompt y/N (default No). A non-TTY stdin reads as No. Mirrors sync.ts. */
function promptYesNo(): boolean {
  const answer = prompt("Proceed? [y/N]");
  return answer != null && /^y(es)?$/i.test(answer.trim());
}

// ── Merge ─────────────────────────────────────────────────────────────────────
/**
 * Fold the SOURCE db's new webcam rows into the TARGET db (see the file header).
 * Throws on failure so the caller decides how to report it. `sync --merge` calls
 * this in-process; the CLI at the bottom wraps it for standalone `bun merge` use.
 */
export function mergeDbs(
  sourcePath: string,
  targetPath: string,
  opts: { dryRun?: boolean; yes?: boolean } = {},
): void {
  const { dryRun = false, yes = false } = opts;
  const source = openReadonly(sourcePath);
  try {
    if (webcamColumns(source).length === 0) {
      throw new Error(`source ${sourcePath} has no 'webcams' table`);
    }

    // Compute the delta against a READ-ONLY target handle. The target is only reopened
    // read-write if there is something to insert and you confirm, so --dry-run and an
    // aborted run never write to (or even open for writing) the target.
    const targetRO = openReadonly(targetPath);
    let toAdd: KeyRow[];
    let startingRows: number;
    let srcCount: number;
    let cols: string[];
    try {
      if (webcamColumns(targetRO).length === 0) {
        throw new Error(`target ${targetPath} has no 'webcams' table`);
      }
      const tgtKeys = new Set(
        (targetRO.query("SELECT ip_str, port FROM webcams").all() as KeyRow[]).map(keyOf),
      );
      const srcRows = source
        .query("SELECT ip_str, port, country_name FROM webcams")
        .all() as KeyRow[];
      toAdd = srcRows.filter((r) => !tgtKeys.has(keyOf(r)));
      srcCount = srcRows.length;
      startingRows = tgtKeys.size;
      cols = commonColumns(source, targetRO);
    } finally {
      targetRO.close();
    }

    const shared = srcCount - toAdd.length; // source cams the target already has
    const targetOnly = startingRows - shared; // target cams the source lacks (your local work)

    console.log(`\n── DB merge ──`);
    console.log(`Source (read-only):  ${sourcePath}`);
    console.log(`Target:              ${targetPath}`);
    console.log(`\nSource webcams:           ${srcCount.toLocaleString()}`);
    console.log(`Target webcams:           ${startingRows.toLocaleString()}`);
    console.log(`New in source (to add):   ${toAdd.length.toLocaleString()}`);
    console.log(`Target-only (untouched):  ${targetOnly.toLocaleString()}`);
    console.log(`Shared (untouched):       ${shared.toLocaleString()}`);

    if (toAdd.length === 0) {
      console.log(`\n✓ Target already has every camera in the source. Nothing to add.`);
      return;
    }

    const sample = toAdd.slice(0, 10);
    console.log(`\nNew cameras:`);
    for (const r of sample) {
      console.log(`  ${r.ip_str}:${r.port}${r.country_name ? `  ${r.country_name}` : ""}`);
    }
    if (toAdd.length > sample.length) {
      console.log(`  … and ${(toAdd.length - sample.length).toLocaleString()} more`);
    }

    if (dryRun) {
      console.log(`\nDry run: no changes written.`);
      return;
    }

    console.log(
      `\nThis will INSERT ${toAdd.length.toLocaleString()} new webcam(s) into ${targetPath}.`,
    );
    console.log(`Existing rows in the target are left untouched.`);
    if (!yes && !promptYesNo()) {
      console.log("Aborted.");
      return;
    }

    // Reopen the target read-write for the insert only. A plain open (not openDb) so the
    // app's schema/seed side effects never run on the other tables — only `webcams` is
    // touched. Copy each missing row verbatim (every column both tables share, incl.
    // first_seen / last_seen / preferred), streamed one at a time so a large delta never
    // holds more than one camera's base64 image in memory. Plain INSERT (not OR IGNORE):
    // the keys are known-absent, so a conflict is a real anomaly and should surface.
    const target = new Database(targetPath, { readwrite: true, create: false, strict: true });
    try {
      target.run("PRAGMA busy_timeout = 5000;");
      const sel = source.query(
        `SELECT ${cols.join(", ")} FROM webcams WHERE ip_str = ? AND port = ?`,
      );
      const ins = target.query(
        `INSERT INTO webcams (${cols.join(", ")}) VALUES (${cols.map((c) => `$${c}`).join(", ")})`,
      );
      const insertMissing = target.transaction((keys: KeyRow[]): number => {
        let n = 0;
        for (const k of keys) {
          ins.run(sel.get(k.ip_str, k.port) as Record<string, string | number | null>);
          n++;
        }
        return n;
      });
      const added = insertMissing(toAdd);
      const endingRows = countRows(target);

      console.log(`\n── Merge summary ──`);
      console.log(`Added to target:  ${added.toLocaleString()} new webcams`);
      console.log(`Target rows:      ${startingRows.toLocaleString()} → ${endingRows.toLocaleString()}`);
      console.log(`\n✓ Merged ${added.toLocaleString()} new webcams into ${targetPath}.`);
    } finally {
      // Checkpoint the WAL back into the main file so the insert is durable with no
      // stale -wal/-shm left beside the target.
      closeDb(target);
    }
  } finally {
    source.close();
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
    allowPositionals: true,
  });

  const sourcePath = positionals[0];
  const targetPath = positionals[1];

  if (!sourcePath || !targetPath) {
    console.error("Two database paths are required: <source> then <target>.");
    console.error(USAGE);
    process.exit(1);
  }
  if (positionals.length > 2) {
    console.error(`Too many arguments: ${positionals.slice(2).join(" ")}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (resolve(sourcePath) === resolve(targetPath)) {
    console.error("Source and target are the same file; nothing to merge.");
    process.exit(1);
  }
  for (const p of [sourcePath, targetPath]) {
    if (!(await Bun.file(p).exists())) {
      console.error(`No such file: ${p}`);
      process.exit(1);
    }
  }

  try {
    mergeDbs(sourcePath, targetPath, {
      dryRun: values["dry-run"] ?? false,
      yes: values.yes ?? false,
    });
  } catch (err) {
    console.error(`\n✗ Merge failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
