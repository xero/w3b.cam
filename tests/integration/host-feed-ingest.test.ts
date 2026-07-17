import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, makeInserter, openDb } from "../../src/db/db.ts";
import { cleanTmpDir, makeTmpSpace, type TmpSpace } from "../helpers/tmp.ts";
import { TINY_PNG_B64, TINY_PNG_HASH, TINY_PNG_MIME } from "../fixtures/tinyimg.ts";
import type { CamRow } from "../../src/core/types.ts";

// The cam upsert hook (makeInserter → afterUpsert) derives a browser-playable live_url from
// each host's own stored HTML on every (re)ingest — the permanent home of host-feed
// derivation. live_url is omitted from CAM_COLUMNS, so the hook's write survives re-ingest.

let space: TmpSpace;
beforeEach(() => {
	space = makeTmpSpace("w3bcam-hostfeed-");
});
afterEach(() => cleanTmpDir(space.dir));

function camRow(ip: string, port: number, rawJson: string): CamRow {
	return {
		id: `${ip}:${port}`,
		kind: "cam",
		source: "shodan",
		feed_kind: "screenshot",
		name: ip,
		product: null,
		ip_str: ip,
		port,
		lat: null,
		lng: null,
		city: null,
		country_code: null,
		country_name: null,
		region_code: null,
		ss_mime: TINY_PNG_MIME,
		ss_hash: TINY_PNG_HASH,
		ss_base64: TINY_PNG_B64,
		shodan_id: null,
		hostnames: "[]",
		domains: "[]",
		org: null,
		isp: null,
		asn: null,
		observed_at: "2024-01-01T00:00:00Z",
		raw_json: rawJson,
	};
}

const httpsBanner = (html: string) => JSON.stringify({ ssl: {}, http: { html } });
const httpBanner = (html: string) => JSON.stringify({ http: { html } });

function liveUrlOf(db: ReturnType<typeof openDb>, id: string): string | null {
	const r = db.query("SELECT live_url AS u FROM cams WHERE id = ?").get(id) as { u: string | null } | null;
	return r?.u ?? null;
}

describe("cam ingest derives live_url from the host HTML (afterUpsert)", () => {
	it("sets a derived URL for a host whose page advertises a stream/snapshot path", () => {
		const db = openDb(space.dbPath);
		try {
			makeInserter(db)([
				camRow("10.0.0.1", 443, httpsBanner(`<img src="/mjpg/video.mjpg">`)),
				camRow("10.0.0.9", 8080, httpBanner(`<a href="/control/faststream.jpg?stream=full">`)),
			]);
			expect(liveUrlOf(db, "10.0.0.1:443")).toBe("https://10.0.0.1/mjpg/video.mjpg");
			expect(liveUrlOf(db, "10.0.0.9:8080")).toBe("http://10.0.0.9:8080/control/faststream.jpg?stream=full");
		} finally {
			closeDb(db);
		}
	});

	it("leaves live_url NULL for a page with no known path and for RTSP hosts", () => {
		const db = openDb(space.dbPath);
		try {
			makeInserter(db)([
				camRow("10.0.0.2", 80, httpBanner(`<html><body>login</body></html>`)),
				camRow("10.0.0.3", 554, httpBanner(`<img src="/mjpg/video.mjpg">`)), // RTSP port → skipped
			]);
			expect(liveUrlOf(db, "10.0.0.2:80")).toBeNull();
			expect(liveUrlOf(db, "10.0.0.3:554")).toBeNull();
		} finally {
			closeDb(db);
		}
	});

	it("self-heals: a re-ingest whose HTML lost the path clears the stale live_url", () => {
		const db = openDb(space.dbPath);
		try {
			const insert = makeInserter(db);
			insert([camRow("10.0.0.4", 443, httpsBanner(`<img src="/mjpg/video.mjpg">`))]);
			expect(liveUrlOf(db, "10.0.0.4:443")).toBe("https://10.0.0.4/mjpg/video.mjpg");
			insert([camRow("10.0.0.4", 443, httpsBanner(`<html>firmware updated</html>`))]);
			expect(liveUrlOf(db, "10.0.0.4:443")).toBeNull();
		} finally {
			closeDb(db);
		}
	});
});
