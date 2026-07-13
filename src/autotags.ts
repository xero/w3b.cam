// Derived "auto-tags": metadata we already hold on the view models but never hand-tagged.
// Computed at build time from the grouped `hosts` / `feedCams`, then merged into the tag
// cloud (and its per-tag browse galleries) alongside the real `meta`-table tags. They are
// NOT written to the DB and never enter loadTags, so they appear only in the cloud — not on
// per-entity detail pages, and not on the homepage top-tags column (see build.ts).
//
// Each auto-tag carries the same {kind, ref} entity list the tag-browse loop already
// filters on: cam refs are a host's IP, feed refs are a feed's id — so a gallery is built
// with zero changes to the browse renderer.

import type { FeedCam, Host } from "./render.ts";

export type AutoTag = { tag: string; refs: { kind: "cam" | "feed"; ref: string }[] };

/** A host counts as RTSP if any of its ports is 554 or any angle's product mentions RTSP. */
const hasRtsp = (h: Host): boolean =>
	h.shots.some((s) => s.port === 554 || (s.product ?? "").toLowerCase().includes("rtsp"));

/** The HTTP port family we treat as "http" (plain-text web transports). */
const HTTP_PORTS = new Set([80, 88, 8080, 8888]);

/**
 * The six derived auto-tags, in a fixed order (the cloud re-sorts alphabetically anyway).
 * Any tag that matches nothing this build is dropped so the cloud never shows an empty tag.
 */
export function computeAutoTags(hosts: Host[], feedCams: FeedCam[]): AutoTag[] {
	const camRefs = (pred: (h: Host) => boolean) =>
		hosts.filter(pred).map((h) => ({ kind: "cam" as const, ref: h.ip }));
	const feedRefs = (pred: (c: FeedCam) => boolean) =>
		feedCams.filter(pred).map((c) => ({ kind: "feed" as const, ref: c.id }));

	return [
		// Hosts grouped onto more than one port/angle by groupByIp (the "N angles" card badge).
		{ tag: "multi-angle", refs: camRefs((h) => h.count > 1) },
		// Auto-refreshing snapshot feeds: embedded refreshing JPEGs plus true multipart MJPEG.
		{ tag: "mjpeg", refs: feedRefs((c) => c.feedKind === "jpg" || c.feedKind === "mjpeg") },
		// HTTP Live Streaming feeds.
		{ tag: "hls", refs: feedRefs((c) => c.feedKind === "hls") },
		{ tag: "rtsp", refs: camRefs(hasRtsp) },
		{ tag: "http", refs: camRefs((h) => h.shots.some((s) => HTTP_PORTS.has(s.port))) },
		{ tag: "https", refs: camRefs((h) => h.shots.some((s) => s.port === 443)) },
	].filter((a) => a.refs.length > 0);
}
