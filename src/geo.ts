// Geo: assign manual coordinates to a YouTube stream, stored in yt_geo. YouTube
// publishes no location, so these are our own best-guess lat/lng (from the place
// named in the stream's title) that place the stream on the map. One coord per
// video; re-running replaces it. Re-run `bun run bake` afterwards to reflect it on
// the site. No API, no query credits.
//
// Usage:  bun run geo <video_id> <lat> <lng>

import { closeDb, hasStream, openDb, setYtGeo } from "./db.ts";

const id = Bun.argv[2]?.trim();
const lat = Number(Bun.argv[3]);
const lng = Number(Bun.argv[4]);

const validId = !!id && /^[A-Za-z0-9_-]+$/.test(id);
const validLat = Number.isFinite(lat) && lat >= -90 && lat <= 90;
const validLng = Number.isFinite(lng) && lng >= -180 && lng <= 180;

if (!validId || !validLat || !validLng) {
  console.error("Usage: bun run geo <video_id> <lat> <lng>   (lat -90..90, lng -180..180)");
  process.exit(1);
}

const db = openDb();

try {
  setYtGeo(db, id, lat, lng);
  console.log(`\n── Geo summary ──`);
  console.log(`Video:      ${id}`);
  console.log(`Coordinate: ${lat}, ${lng}`);
  if (!hasStream(db, id)) {
    console.warn(`⚠ ${id} is not a stored stream. Check for a typo. Recorded anyway; it applies if the stream is added later.`);
  }
  console.log(`Next:       run \`bun run bake\` to regenerate the site.`);
} finally {
  closeDb(db);
}
