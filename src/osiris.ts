// Internal Osiris re-ingest command (deliberately NOT part of `bun import`). Re-reads
// the Osiris camera dump into the `cams` table, refreshing each cam's baked card
// thumbnail (and last_seen), and routes any YouTube cams to the youtube table. The
// dump is large and lives under in/ (gitignored), so this is a rare, hand-run
// maintenance command; CI's feed workflow invokes it when the dump is committed.
//
// Usage:
//   bun run osiris [file]                  (default file: in/new/osiris-cameras.json)
//   bun run osiris --limit 50              cap the number of ingested cams
//   bun run osiris --source TfL            only cams whose source contains "TfL"
//   bun run osiris --id cal-79,sin-2701    only these exact cam ids (re-scrape/hand-patch)
//   bun run osiris --concurrency 32        snapshot fan-out (default 24)

import { parseArgs } from "node:util";
import { OSIRIS_JSON } from "./config.ts";
import { closeDb, openDb } from "./db.ts";
import { ingestOsirisFile } from "./ingest.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    limit: { type: "string", short: "l" },
    source: { type: "string", short: "s" },
    id: { type: "string" },
    concurrency: { type: "string", short: "c" },
  },
  allowPositionals: true,
});

const num = (s?: string): number => (s ? Math.max(1, Number.parseInt(s, 10) || 0) : 0);
const ytKey = process.env.YOUTUBE_API_KEY?.trim() || undefined;

const db = openDb();
try {
  await ingestOsirisFile(db, positionals[0] ?? OSIRIS_JSON, {
    limit: num(values.limit),
    source: values.source,
    id: values.id,
    concurrency: num(values.concurrency),
    ytKey,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closeDb(db);
}
