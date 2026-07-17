// Hand-built feed + stream fixture rows. Feed/stream ingestion needs network + ffmpeg +
// a YouTube API key, so we never run those importers in tests; instead we upsert fully
// formed rows straight through the exported inserters (makeFeedInserter / makeYtInserter),
// which do zero IO. Every row carries a screenshot so the baked site actually renders it
// (bake only emits rows with ss_base64).
//
// Stream ids Yw8CZCEOdXE / UNbOvsRAx9U match FEATURED_SEED in src/db/db.ts, so a fresh DB
// pins them on the homepage for free.

import type { FeedRow, YtRow } from "../../src/core/types.ts";
import { TINY_PNG_B64, TINY_PNG_HASH, TINY_PNG_MIME } from "./tinyimg.ts";

const img = { ss_mime: TINY_PNG_MIME, ss_hash: TINY_PNG_HASH, ss_base64: TINY_PNG_B64 };

// A few filler feeds so the feeds gallery spans more than one page (PAGE_SIZE = 8),
// giving the e2e pager + link-crawl real pagination to exercise.
function fillerFeed(i: number): FeedRow {
	return {
		id: `fill-feed-${i}`,
		kind: "feed",
		source: "fixture",
		feed_kind: "jpg",
		name: `Filler Cam ${i}`,
		city: "Testville",
		country_name: "United States",
		lat: null,
		lng: null,
		live_url: `https://example.test/fill/${i}.jpg`,
		external_url: null,
		raw_json: JSON.stringify({ fixture: true, filler: i }),
		...img,
	};
}

export const FEED_FIXTURES: FeedRow[] = [
	...Array.from({ length: 8 }, (_, i) => {
		const f = fillerFeed(i + 1);
		// Two fillers share one isolated coordinate, giving the map a co-located pair. Geo-IP
		// routinely stacks cameras on identical coords, and the e2e map spec clicks this pair to
		// prove a cluster that zoom can't split opens a list. Far from every other fixture point.
		if (i === 0 || i === 1) {
			f.lat = 61.5;
			f.lng = 105.3;
			f.city = "Krasnoyarsk";
			f.country_name = "Russia";
		}
		return f;
	}),
	{
		id: "mjpeg-38.79.156.188",
		kind: "feed",
		source: "511PA",
		feed_kind: "jpg",
		name: "10th St Bypass @ I-279",
		city: "Pittsburgh",
		country_name: "United States",
		lat: 40.4406,
		lng: -79.9959,
		live_url: "https://www.example-cams.test/cctv/5322.jpg",
		external_url: "https://www.example-cams.test/map/Cctv/5322",
		raw_json: JSON.stringify({ fixture: true, kind: "feed", feed_kind: "jpg" }),
		...img,
	},
	{
		id: "butler-oh-129-747",
		kind: "feed",
		source: "Butler County, OH",
		feed_kind: "mp4",
		name: "OH-129 at 747",
		city: "Butler County",
		country_name: "United States",
		lat: 39.381435,
		lng: -84.438423,
		live_url: "https://towercam.example.test/media.mp4",
		external_url: "https://towercam.example.test/view",
		raw_json: JSON.stringify({ fixture: true, kind: "feed", feed_kind: "mp4" }),
		...img,
	},
	{
		id: "hls-demo-bridge",
		kind: "feed",
		source: "caltrans",
		feed_kind: "hls",
		name: "Bay Bridge West Span",
		city: "San Francisco",
		country_name: "United States",
		lat: 37.7983,
		lng: -122.3778,
		live_url: "https://stream.example.test/bridge/index.m3u8",
		external_url: null,
		raw_json: JSON.stringify({ fixture: true, kind: "feed", feed_kind: "hls" }),
		...img,
	},
];

function stream(id: string, name: string, live: boolean): YtRow {
	return {
		id,
		kind: "stream",
		source: "youtube",
		feed_kind: "youtube",
		name,
		live_url: `https://www.youtube.com/watch?v=${id}`,
		label: name,
		title: name,
		description: `${name} — fixture stream`,
		channel_id: `chan-${id}`,
		channel_title: `Channel ${id}`,
		published_at: "2024-01-01T00:00:00Z",
		live_content: live ? "live" : "none",
		scheduled_start: null,
		actual_start: live ? "2024-01-01T00:00:00Z" : null,
		thumbnail_url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
		raw_json: JSON.stringify({ fixture: true, kind: "stream", id }),
		...img,
	};
}

export const STREAM_FIXTURES: YtRow[] = [
	stream("Yw8CZCEOdXE", "Times Square Live", true),
	stream("UNbOvsRAx9U", "Shibuya Crossing", true),
	stream("aBcDeFgHiJk", "Harbor Cam (offline)", false),
];
