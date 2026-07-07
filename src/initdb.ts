// initdb: create camhunting.sqlite (schema + seeded blacklists) without scraping.
// openDb already creates the file, applies the schema, and seeds the blacklists on a
// fresh DB. This triggers that and reports, so you can produce a DB to upload to the
// db-store release before the first CI run. Safe to run against an existing DB (no-op).
//
// Usage:  bun run initdb

import { DB_PATH } from "./config.ts";
import { closeDb, countRows, openDb } from "./db.ts";

const db = openDb();
const rows = countRows(db);
closeDb(db);
console.log(`Initialized ${DB_PATH} (${rows} cameras).`);
