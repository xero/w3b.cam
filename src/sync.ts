// Sync: move the SQLite DB between your local copy and the production db-store
// release, git-style. camhunting.sqlite (~441MB) is gitignored and never in git;
// it lives as an asset on the "db-store" prerelease, and the scrape/tag/build
// workflows restore it from there before running and save it back after. This is
// the manual counterpart to that: seed the store from your local copy, or pull
// the store (which the 6-hourly scraper keeps mutating) down to work on locally.
//
// Both directions clobber a whole DB, so it prints a local-vs-remote comparison
// and asks to confirm first (--yes / -y / -f skips the prompt).
//
// Usage:  bun run sync --push   (local -> store, then trigger build.yml redeploy)
//         bun run sync --pull   (store -> local, clobbering the local copy)

import { $ } from "bun";
import { unlinkSync } from "node:fs";
import { DB_PATH } from "./config.ts";
import { closeDb, openDb } from "./db.ts";

const RELEASE = "db-store";
const ASSET = DB_PATH; // "camhunting.sqlite"
const BUILD_WORKFLOW = "build.yml";
const USAGE = "Usage: bun run sync <--push|--pull> [--yes]";

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = Bun.argv.slice(2);
const YES_FLAGS = ["--yes", "-y", "-f"];
const wantYes = args.some((a) => YES_FLAGS.includes(a));
const rest = args.filter((a) => !YES_FLAGS.includes(a));

const push = rest.some((a) => a === "--push" || a === "push");
const pull = rest.some((a) => a === "--pull" || a === "pull");
const unknown = rest.filter((a) => !["--push", "push", "--pull", "pull"].includes(a));

if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}`);
  console.error(USAGE);
  process.exit(1);
}
if (push === pull) {
  // Neither (nothing selected) or both (ambiguous) is invalid; a direction is required.
  console.error(push ? "Pick one direction, not both." : "A direction is required.");
  console.error(USAGE);
  process.exit(1);
}
const direction: "push" | "pull" = push ? "push" : "pull";

// ── Metadata ──────────────────────────────────────────────────────────────────
/** A DB copy's size (bytes) and last-modified time (ms epoch, null if unknown). */
interface Meta {
  size: number;
  mtime: number | null;
}

function fmtSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ms: number | null): string {
  return ms == null ? "-" : new Date(ms).toLocaleString();
}

/** Coarse human duration for the "overwriting newer data" warning. */
function humanDelta(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h`;
  return `${Math.round(hr / 24)} d`;
}

async function localMeta(): Promise<Meta | null> {
  const file = Bun.file(DB_PATH);
  if (!(await file.exists())) return null;
  return { size: file.size, mtime: file.lastModified };
}

async function remoteMeta(): Promise<Meta | null> {
  const res = await $`gh release view ${RELEASE} --json assets`.nothrow().quiet();
  if (res.exitCode !== 0) return null; // store release doesn't exist yet
  const { assets } = JSON.parse(res.stdout.toString()) as {
    assets: { name: string; size: number; updatedAt: string }[];
  };
  const asset = assets.find((a) => a.name === ASSET);
  if (!asset) return null;
  return { size: asset.size, mtime: Date.parse(asset.updatedAt) };
}

// ── Preflight / comparison / confirm ──────────────────────────────────────────
async function preflight(): Promise<void> {
  const res = await $`gh auth status`.nothrow().quiet();
  if (res.exitCode !== 0) {
    console.error("gh CLI must be installed and authenticated. Run: gh auth login");
    process.exit(1);
  }
}

function printComparison(local: Meta | null, remote: Meta | null): void {
  console.log(`\n── DB sync (${direction}) ──`);
  console.log(`Local  (${DB_PATH}):  ${local ? `${fmtSize(local.size)}   ${fmtTime(local.mtime)}` : "- (missing)"}`);
  console.log(`Remote (${RELEASE}):  ${remote ? `${fmtSize(remote.size)}   ${fmtTime(remote.mtime)}` : "- (empty)"}`);

  const source = direction === "push" ? local : remote;
  const target = direction === "push" ? remote : local;
  const sourceName = direction === "push" ? "local copy" : "remote store";
  const targetName = direction === "push" ? "remote store" : "local copy";

  // The whole point of the comparison: catch overwriting fresher data with stale.
  if (source?.mtime != null && target?.mtime != null && target.mtime > source.mtime) {
    console.warn(
      `\n⚠ The ${targetName} you're about to overwrite is NEWER than your ${sourceName}` +
        ` (by ${humanDelta(target.mtime - source.mtime)}). You may be clobbering fresher data.` +
        `\n  (mtime is only a rough proxy; a touch or copy bumps it.)`,
    );
  }
  console.log(`\nThis will CLOBBER the ${targetName} with the ${sourceName}.`);
}

/** Prompt y/N (default No). Bypassed by --yes; a non-TTY stdin reads as No. */
function confirm(): boolean {
  if (wantYes) return true;
  const answer = prompt("Proceed? [y/N]");
  return answer != null && /^y(es)?$/i.test(answer.trim());
}

// ── Directions ────────────────────────────────────────────────────────────────
async function doPush(): Promise<void> {
  if (!(await Bun.file(DB_PATH).exists())) {
    console.error(`No local DB at ${DB_PATH}. Nothing to push.`);
    process.exit(1);
  }
  // Fold any pending WAL back into the main file (and drop the sidecars) so the
  // uploaded copy is complete; closeDb runs wal_checkpoint(TRUNCATE). Schema /
  // migrate / seed on open are all no-ops on the populated DB.
  closeDb(openDb());

  const local = await localMeta();
  const remote = await remoteMeta();
  printComparison(local, remote);
  if (!confirm()) {
    console.log("Aborted.");
    return;
  }

  // Create the store on first push, then overwrite the asset (workflows' commands).
  if ((await $`gh release view ${RELEASE}`.nothrow().quiet()).exitCode !== 0) {
    await $`gh release create ${RELEASE} --prerelease --title ${"SQLite store"} --notes ${"camhunting.sqlite persistent store, do not delete"}`;
  }
  console.log(`Uploading ${DB_PATH} (${local ? fmtSize(local.size) : "?"}) to ${RELEASE}…`);
  await $`gh release upload ${RELEASE} ${DB_PATH} --clobber`;

  // The live site only reflects the store once build.yml runs; kick it off.
  console.log(`Triggering ${BUILD_WORKFLOW} to rebuild & deploy…`);
  await $`gh workflow run ${BUILD_WORKFLOW}`;
  console.log(`\n✓ Pushed. Site redeploys shortly. Watch with: gh run watch`);
}

async function doPull(): Promise<void> {
  const local = await localMeta();
  const remote = await remoteMeta();
  if (!remote) {
    console.error(`No ${ASSET} in the ${RELEASE} store. Nothing to pull.`);
    process.exit(1);
  }
  printComparison(local, remote);
  if (!confirm()) {
    console.log("Aborted.");
    return;
  }

  console.log(`Downloading ${ASSET} (${fmtSize(remote.size)}) from ${RELEASE}…`);
  await $`gh release download ${RELEASE} --pattern ${ASSET} --clobber`;

  // Drop stale WAL/SHM: left beside the freshly downloaded main file, SQLite
  // would replay old writes over it on next open and corrupt the DB.
  for (const ext of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${DB_PATH}${ext}`);
    } catch {}
  }
  const after = await localMeta();
  console.log(`\n✓ Pulled. Local ${DB_PATH} is now ${after ? fmtSize(after.size) : "?"}.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
  await preflight();
  if (direction === "push") await doPush();
  else await doPull();
} catch (err) {
  console.error(`\n✗ Sync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
