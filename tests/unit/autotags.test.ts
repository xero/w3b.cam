import { describe, expect, it } from "bun:test";
import { computeAutoTags } from "../../src/site/autotags.ts";
import type { FeedCam, Host } from "../../src/site/render.ts";

// computeAutoTags only reads a few fields off each view model; cast partials to keep the
// fixtures focused on what the tag predicates actually look at.
function host(ip: string, shots: { port: number; product?: string | null; liveUrl?: string | null }[]): Host {
	return {
		ip,
		count: shots.length,
		shots: shots.map((s) => ({ port: s.port, product: s.product ?? null, timestamp: null, imgHref: "", imgAlt: "", liveHref: "", liveUrl: s.liveUrl ?? null })),
	} as unknown as Host;
}
const feed = (id: string, feedKind: FeedCam["feedKind"]): FeedCam => ({ id, feedKind }) as unknown as FeedCam;
const byTag = (tags: ReturnType<typeof computeAutoTags>, name: string) => tags.find((t) => t.tag === name)!;

describe("computeAutoTags — derived host feeds join the mjpeg/hls tags", () => {
	it("tags hosts with a derived mjpeg or jpg URL under `mjpeg`, alongside the feed cams", () => {
		const hosts = [
			host("1.1.1.1", [{ port: 443, liveUrl: "https://1.1.1.1/mjpg/video.mjpg" }]), // mjpeg (https)
			host("2.2.2.2", [{ port: 80, liveUrl: "http://2.2.2.2/jpg/image.jpg" }]), // jpg (http, link) → still mjpeg tag
			host("3.3.3.3", [{ port: 8080 }]), // no derived url → not tagged
		];
		const mjpeg = byTag(computeAutoTags(hosts, [feed("f-mjpeg", "mjpeg"), feed("f-jpg", "jpg")]), "mjpeg");
		expect(mjpeg.refs).toContainEqual({ kind: "cam", ref: "1.1.1.1" });
		expect(mjpeg.refs).toContainEqual({ kind: "cam", ref: "2.2.2.2" });
		expect(mjpeg.refs).toContainEqual({ kind: "feed", ref: "f-mjpeg" });
		expect(mjpeg.refs).toContainEqual({ kind: "feed", ref: "f-jpg" });
		expect(mjpeg.refs.some((r) => r.ref === "3.3.3.3")).toBe(false);
	});

	it("keeps `hls` feed-only — hosts never derive HLS", () => {
		const hosts = [host("1.1.1.1", [{ port: 443, liveUrl: "https://1.1.1.1/mjpg/video.mjpg" }])];
		const hls = byTag(computeAutoTags(hosts, [feed("f-hls", "hls")]), "hls");
		expect(hls.refs).toEqual([{ kind: "feed", ref: "f-hls" }]);
	});
});
