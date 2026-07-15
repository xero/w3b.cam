// Build a small, self-consistent fixture DB, fully offline. Cams go in via the real
// Shodan import path (embedded base64, no network); feeds + streams are upserted straight
// through the exported inserters (no network/ffmpeg/API). A few tags, a feed feature, and
// a super-feature group are added so the tag cloud, fingerprints, featured homepage, and
// /event pages all populate.

import { join } from "node:path";
import {
	addFeatured,
	addSuperFeature,
	addTag,
	closeDb,
	makeFeedInserter,
	makeYtInserter,
	openDb,
} from "../../src/db/db.ts";
import { ingestShodanDir } from "../../src/ingest/ingest.ts";
import { FEED_FIXTURES, STREAM_FIXTURES } from "../fixtures/rows.ts";

/** Directory holding the committed Shodan fixture JSON (scanned like `in/`). */
export const SHODAN_FIXTURE_DIR = join(import.meta.dir, "../fixtures/shodan");

/** The event key used to group two feeds into a super-feature (see /event/<slug>). */
export const EVENT_KEY = "test-event";

/**
 * Open `dbPath` (created + seeded by openDb), fill it with the fixture data, and close it.
 * Idempotent enough for tests: re-running upserts the same rows.
 */
export async function prepFixtureDb(dbPath: string): Promise<void> {
	const db = openDb(dbPath);
	try {
		await ingestShodanDir(db, SHODAN_FIXTURE_DIR);
		makeFeedInserter(db)(FEED_FIXTURES);
		makeYtInserter(db)(STREAM_FIXTURES);

		// Pin one vendor on the Hikvision host (both ports) so a per-vendor gallery exists to
		// navigate to. Seeded directly rather than depending on the classifier deriving a vendor
		// from the fixture product string. ref = cams.id ('ip:port'); build dedupes to the host.
		const fp = db.query(
			"INSERT OR REPLACE INTO fingerprints (kind, ref, tier, method, vendor, evidence) VALUES ('cam', ?, 'high', 'product', 'hikvision', 'Hikvision IP Camera')",
		);
		fp.run("160.72.56.179:8080");
		fp.run("160.72.56.179:81");

		// Real tag members: reuse a seeded tag slug (graffiti) plus fresh tags across kinds.
		addTag(db, "cam", "160.72.56.179", "graffiti");
		addTag(db, "stream", "Yw8CZCEOdXE", "cityscape");
		addTag(db, "feed", "hls-demo-bridge", "bridge");

		// The seed already features the two cam IPs + two stream ids; add a feed so every
		// kind is represented on the homepage featured row.
		addFeatured(db, "feed", "mjpeg-38.79.156.188");

		// Two feeds grouped under one event key -> a combined /event/<slug> page + banner.
		addSuperFeature(db, EVENT_KEY, "butler-oh-129-747");
		addSuperFeature(db, EVENT_KEY, "hls-demo-bridge");
	} finally {
		closeDb(db);
	}
}
