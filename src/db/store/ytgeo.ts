import type { Database } from "bun:sqlite";

// ── Stream geo (manual coordinates, kept inline on the cam row) ────────────────

/**
 * Every stream's coordinates as a map of video_id -> {lat, lng}, loaded once for a
 * build. Streams with no assigned coord are absent (the build gives them no map dot).
 * Companion to loadTags. YouTube publishes no location, so these are hand-assigned
 * (see setYtGeo / `bun run geo`), stored inline on the stream's `cams` row.
 */
export function loadYtGeo(db: Database): Map<string, { lat: number; lng: number }> {
	const rows = db
		.query("SELECT id, lat, lng FROM cams WHERE kind = 'stream' AND lat IS NOT NULL AND lng IS NOT NULL")
		.all() as { id: string; lat: number; lng: number }[];
	const map = new Map<string, { lat: number; lng: number }>();
	for (const r of rows) map.set(r.id, { lat: r.lat, lng: r.lng });
	return map;
}

/** Set (or replace) a stream's coordinates inline on its `cams` row. No-op if the stream isn't stored. */
export function setYtGeo(db: Database, videoId: string, lat: number, lng: number): void {
	db.query("UPDATE cams SET lat = ?, lng = ? WHERE kind = 'stream' AND id = ?").run(lat, lng, videoId);
}
