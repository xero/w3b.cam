// Sync: move the SQLite DB between your local copy and the production db-store
// release, git-style. camhunting.sqlite (~441MB) is gitignored and never in git;
// it lives as an asset on the "db-store" prerelease, and the scrape/tag/build
// workflows restore it from there before running and save it back after. This is
// the manual counterpart to that: seed the store from your local copy, or pull
// the store (which the 6-hourly scraper keeps mutating) down to work on locally.
//
// Both push and pull clobber a whole DB, so each prints a local-vs-remote
// comparison and asks to confirm first (--yes / -y / -f skips the prompt).
// --merge is the non-destructive pull: it folds the store's newly-scraped cameras
// into your local copy instead of overwriting it, so unpushed local edits survive,
// and it keeps a timestamped backup. It runs unattended (no prompt).
//
// Usage:  bun run sync --push    (local -> store, then trigger build.yml redeploy)
//         bun run sync --pull    (store -> local, clobbering the local copy)
//         bun run sync --merge   (store -> local, merging in new cams, keeping local edits)

import { $ } from "bun";
import { copyFileSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import { DB_PATH } from "../core/config.ts";
import { closeDb, openDb } from "./db.ts";
import { mergeDbs } from "./merge.ts";
import { promptYesNo } from "../core/util.ts";

const RELEASE = "db-store";
const ASSET = basename(DB_PATH); // "camhunting.sqlite": gh names an asset after the file
const MAX_ASSET = 2 ** 31; // GitHub's per-asset ceiling; an upload at or over it 422s
const BUILD_WORKFLOW = "build.yml";
const USAGE = "Usage: bun run sync <--push|--pull|--merge> [--yes]";

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = Bun.argv.slice(2);
const YES_FLAGS = ["--yes", "-y", "-f"];
const wantYes = args.some((a) => YES_FLAGS.includes(a));
const rest = args.filter((a) => !YES_FLAGS.includes(a));

const push = rest.some((a) => a === "--push" || a === "push");
const pull = rest.some((a) => a === "--pull" || a === "pull");
const merge = rest.some((a) => a === "--merge" || a === "merge");
const KNOWN = ["--push", "push", "--pull", "pull", "--merge", "merge"];
const unknown = rest.filter((a) => !KNOWN.includes(a));

if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(" ")}`);
  console.error(USAGE);
  process.exit(1);
}
const modeCount = [push, pull, merge].filter(Boolean).length;
if (modeCount !== 1) {
  // Neither (nothing selected) or several (ambiguous) is invalid; exactly one is required.
  console.error(modeCount === 0 ? "A mode is required." : "Pick exactly one of --push / --pull / --merge.");
  console.error(USAGE);
  process.exit(1);
}
const mode: "push" | "pull" | "merge" = push ? "push" : pull ? "pull" : "merge";

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

/** One store asset as `gh release view --json assets` reports it. */
interface Asset {
  name: string;
  size: number;
  state: string;
  updatedAt: string;
  apiUrl: string;
}

/** The store's assets, or [] if the release doesn't exist yet. */
async function remoteAssets(): Promise<Asset[]> {
  const res = await $`gh release view ${RELEASE} --json assets`.nothrow().quiet();
  if (res.exitCode !== 0) return [];
  return (JSON.parse(res.stdout.toString()) as { assets: Asset[] }).assets;
}

async function remoteMeta(): Promise<Meta | null> {
  const asset = (await remoteAssets()).find((a) => a.name === ASSET);
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
  console.log(`\n── DB sync (${mode}) ──`);
  console.log(`Local  (${DB_PATH}):  ${local ? `${fmtSize(local.size)}   ${fmtTime(local.mtime)}` : "- (missing)"}`);
  console.log(`Remote (${RELEASE}):  ${remote ? `${fmtSize(remote.size)}   ${fmtTime(remote.mtime)}` : "- (empty)"}`);

  // Merge never clobbers, so the stale-overwrite warning below doesn't apply.
  if (mode === "merge") {
    console.log(
      `\nThis will MERGE the ${RELEASE} store's new cameras into your local copy` +
        ` (local curation preserved; a timestamped .bak is kept).`,
    );
    return;
  }

  const source = mode === "push" ? local : remote;
  const target = mode === "push" ? remote : local;
  const sourceName = mode === "push" ? "local copy" : "remote store";
  const targetName = mode === "push" ? "remote store" : "local copy";

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
  return wantYes || promptYesNo();
}

// ── Directions ────────────────────────────────────────────────────────────────
/** Drop SQLite's stale -wal/-shm sidecars beside `path` (best-effort; a missing one is fine). */
function dropSidecars(path: string): void {
  for (const ext of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${ext}`);
    } catch {}
  }
}

/**
 * Download the store asset to `dest`, then drop the stale -wal/-shm sidecars left
 * beside it — SQLite would otherwise replay old writes over the fresh file and
 * corrupt it. `-O` writes straight to `dest`, so a merge can stage prod under a
 * scratch name without ever touching the live DB.
 */
async function downloadStore(dest: string): Promise<void> {
  await $`gh release download ${RELEASE} --pattern ${ASSET} -O ${dest} --clobber`;
  dropSidecars(dest);
}

/**
 * Upload without ever leaving the store empty. `gh release upload --clobber` deletes
 * the live asset BEFORE uploading, so a failed upload (a dropped connection half-way
 * through 1.5 GB, or the 2 GiB 422 that wiped the store on 2026-09-05) empties it.
 * Instead the file lands under a scratch name, and only once it is verified whole is
 * the live asset renamed aside, the scratch renamed into place, and the old copy
 * deleted. Mirrors .github/actions/save-db, which the workflows use.
 */
async function uploadSwap(size: number): Promise<void> {
  const scratch = `${DB_PATH}.new`;
  const [NEW, PREV] = [`${ASSET}.new`, `${ASSET}.prev`];
  const byName = (assets: Asset[], name: string) => assets.find((a) => a.name === name);
  const rename = (a: Asset, name: string) => $`gh api -X PATCH ${a.apiUrl} -f name=${name} --silent`;

  // A parked copy left by a push that died after promoting would collide below.
  const before = await remoteAssets();
  const stalePrev = byName(before, PREV);
  if (stalePrev) await $`gh release delete-asset ${RELEASE} ${PREV} -y`;

  // Hard link (fall back to a copy) so gh names the asset after the scratch file.
  try {
    linkSync(DB_PATH, scratch);
  } catch {
    copyFileSync(DB_PATH, scratch);
  }
  try {
    await $`gh release upload ${RELEASE} ${scratch} --clobber`;
  } finally {
    unlinkSync(scratch);
  }

  const after = await remoteAssets();
  const fresh = byName(after, NEW);
  if (!fresh || fresh.size !== size || fresh.state !== "uploaded") {
    throw new Error(`scratch upload ${NEW} is incomplete (${fresh?.size ?? "?"} bytes, ${fresh?.state ?? "missing"}); the live asset was left in place`);
  }
  const live = byName(after, ASSET);
  if (live) await rename(live, PREV);
  try {
    await rename(fresh, ASSET);
  } catch (err) {
    throw new Error(`could not promote ${NEW} to ${ASSET}; rename it by hand: gh api -X PATCH ${fresh.apiUrl} -f name=${ASSET} (${err instanceof Error ? err.message : err})`);
  }
  if (live) await $`gh release delete-asset ${RELEASE} ${PREV} -y`.nothrow();
}

async function doPush(): Promise<void> {
  if (!(await Bun.file(DB_PATH).exists())) {
    console.error(`No local DB at ${DB_PATH}. Nothing to push.`);
    process.exit(1);
  }
  // Fold any pending WAL back into the main file (and drop the sidecars) so the
  // uploaded copy is complete; closeDb runs wal_checkpoint(TRUNCATE). Schema /
  // migrate / seed on open are all no-ops on the populated DB.
  closeDb(openDb());

  const local = (await localMeta())!;
  if (local.size >= MAX_ASSET) {
    console.error(`Refusing to push: ${DB_PATH} is ${fmtSize(local.size)}, at or over GitHub's ${fmtSize(MAX_ASSET)} release-asset ceiling; the upload would fail. Shrink the DB first.`);
    process.exit(1);
  }
  const remote = await remoteMeta();
  printComparison(local, remote);
  if (!confirm()) {
    console.log("Aborted.");
    return;
  }

  // Create the store on first push, then swap the asset in (see uploadSwap).
  if ((await $`gh release view ${RELEASE}`.nothrow().quiet()).exitCode !== 0) {
    await $`gh release create ${RELEASE} --prerelease --title ${"SQLite store"} --notes ${"camhunting.sqlite persistent store, do not delete"}`;
  }
  console.log(`Uploading ${DB_PATH} (${fmtSize(local.size)}) to ${RELEASE}…`);
  await uploadSwap(local.size);

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
  await downloadStore(DB_PATH);
  const after = await localMeta();
  console.log(`\n✓ Pulled. Local ${DB_PATH} is now ${after ? fmtSize(after.size) : "?"}.`);
}

async function doMerge(): Promise<void> {
  const local = await localMeta();
  const remote = await remoteMeta();
  if (!remote) {
    console.error(`No ${ASSET} in the ${RELEASE} store. Nothing to pull.`);
    process.exit(1);
  }
  // Nothing local to preserve → a plain pull is the whole job.
  if (!local) {
    printComparison(local, remote);
    console.log(`Downloading ${ASSET} (${fmtSize(remote.size)}) from ${RELEASE}…`);
    await downloadStore(DB_PATH);
    const after = await localMeta();
    console.log(`\n✓ Pulled fresh ${DB_PATH} (${after ? fmtSize(after.size) : "?"}); nothing local to merge.`);
    return;
  }
  printComparison(local, remote); // Info only; merge runs unattended (no confirm).

  // Scratch names derive from DB_PATH so a DB_PATH override still works in isolation.
  const base = DB_PATH.endsWith(".sqlite") ? DB_PATH.slice(0, -".sqlite".length) : DB_PATH;
  const stamp = Math.floor(Date.now() / 1000);
  const backupPath = `${DB_PATH}-${stamp}.bak`;
  const localPath = `${base}-local.sqlite`;
  const prodPath = `${base}-prod.sqlite`;

  // Fold any pending WAL back into the main file so the plain-file copies below are
  // whole (closeDb runs wal_checkpoint(TRUNCATE); schema/migrate/seed on open are
  // no-ops on the populated DB).
  closeDb(openDb());
  copyFileSync(DB_PATH, backupPath); // Safety backup — kept after a successful run.
  copyFileSync(DB_PATH, localPath); // Working copy — becomes the merge target, then the live DB.
  console.log(`Backed up local DB → ${backupPath}`);

  try {
    // Stage prod under a scratch name; the live DB_PATH is untouched until the rename below.
    console.log(`Downloading ${ASSET} (${fmtSize(remote.size)}) from ${RELEASE}…`);
    await downloadStore(prodPath);

    // prod = source, local = target: local's rows (your curation) win; only prod's
    // new cameras are added. Already committed to running, so skip merge's prompt.
    mergeDbs(prodPath, localPath, { yes: true });

    // Atomically swap the merged copy in as the live DB, then drop its stale sidecars.
    renameSync(localPath, DB_PATH);
    dropSidecars(DB_PATH);
  } finally {
    // Drop the prod scratch (+ any sidecars) and, on failure, the leftover working copy.
    // On success localPath was renamed away, so its unlink no-ops. The .bak is kept.
    for (const p of [prodPath, `${prodPath}-wal`, `${prodPath}-shm`, localPath]) {
      try {
        unlinkSync(p);
      } catch {}
    }
  }

  const after = await localMeta();
  console.log(
    `\n✓ Merged ${RELEASE} into ${DB_PATH} (now ${after ? fmtSize(after.size) : "?"}). Backup kept at ${backupPath}.`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
try {
  await preflight();
  if (mode === "push") await doPush();
  else if (mode === "pull") await doPull();
  else await doMerge();
} catch (err) {
  console.error(`\n✗ Sync failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
