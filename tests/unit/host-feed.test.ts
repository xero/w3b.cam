import { describe, expect, it } from "bun:test";
import { deriveHostFeed, isRtspHost, liveKindFromUrl } from "../../src/fingerprint/host-feed.ts";

// Build a Shodan-shaped raw_json with a given HTML body, optionally https (ssl present).
function raw(html: string, opts: { https?: boolean; data?: string } = {}): string {
	const o: Record<string, unknown> = { http: { html } };
	if (opts.https) o.ssl = {};
	if (opts.data) o.data = opts.data;
	return JSON.stringify(o);
}

describe("deriveHostFeed", () => {
	it("extracts an Axis MJPEG stream path from the device HTML (https → embeddable mjpeg)", () => {
		const r = raw(`<script>var imagepath = "/mjpg/1/video.mjpg";</script>`, { https: true });
		expect(deriveHostFeed(r, "1.2.3.4", 443)).toEqual({
			liveUrl: "https://1.2.3.4/mjpg/1/video.mjpg",
			kind: "mjpeg",
			embeddable: true,
		});
	});

	it("keeps a non-default port and marks http as not embeddable (link only)", () => {
		const r = raw(`<img src="/mjpg/video.mjpg?camera=1">`, { https: false });
		expect(deriveHostFeed(r, "9.9.9.9", 8080)).toEqual({
			liveUrl: "http://9.9.9.9:8080/mjpg/video.mjpg?camera=1",
			kind: "mjpeg",
			embeddable: false,
		});
	});

	it("reads a Mobotix faststream viewer path as a motion stream", () => {
		const r = raw(`<a href="/control/faststream.jpg?stream=full">live</a>`, { https: true });
		expect(deriveHostFeed(r, "5.5.5.5", 443)).toMatchObject({
			liveUrl: "https://5.5.5.5/control/faststream.jpg?stream=full",
			kind: "mjpeg",
		});
	});

	it("classifies a single-JPEG snapshot path as jpg", () => {
		const r = raw(`<img id="live" src="/jpg/image.jpg">`, { https: true });
		expect(deriveHostFeed(r, "8.8.8.8", 443)).toMatchObject({ kind: "jpg", liveUrl: "https://8.8.8.8/jpg/image.jpg" });
	});

	it("prefers a motion stream over a snapshot when the page references both", () => {
		const r = raw(`<img src="/jpg/image.jpg"><script>src="/axis-cgi/mjpg/video.cgi"</script>`, { https: true });
		expect(deriveHostFeed(r, "1.1.1.1", 443)!.kind).toBe("mjpeg");
	});

	it("trims a dangling query param left when its value was templated out of the HTML", () => {
		const r = raw(`<img src="/cgi-bin/faststream.jpg?stream=full&amp;fps=">`, { https: true });
		expect(deriveHostFeed(r, "2.2.2.2", 443)!.liveUrl).toBe("https://2.2.2.2/cgi-bin/faststream.jpg?stream=full");
	});

	it("brackets IPv6 hosts", () => {
		const r = raw(`<img src="/mjpg/video.mjpg">`, { https: true });
		expect(deriveHostFeed(r, "2001:db8::1", 8443)!.liveUrl).toBe("https://[2001:db8::1]:8443/mjpg/video.mjpg");
	});

	it("returns null when the HTML references no known stream/snapshot path", () => {
		expect(deriveHostFeed(raw(`<html><body>login</body></html>`, { https: true }), "1.2.3.4", 443)).toBeNull();
	});

	it("returns null for malformed json or empty HTML", () => {
		expect(deriveHostFeed("{not json", "1.2.3.4", 443)).toBeNull();
		expect(deriveHostFeed(raw("", { https: true }), "1.2.3.4", 443)).toBeNull();
	});
});

describe("liveKindFromUrl", () => {
	it("treats known multipart endpoints as mjpeg and stills as jpg", () => {
		expect(liveKindFromUrl("https://h/axis-cgi/mjpg/video.cgi")).toBe("mjpeg");
		expect(liveKindFromUrl("https://h/mjpg/video.mjpg")).toBe("mjpeg");
		expect(liveKindFromUrl("https://h/nphMotionJpeg?Resolution=640x480")).toBe("mjpeg");
		expect(liveKindFromUrl("https://h/control/faststream.jpg?stream=full")).toBe("mjpeg");
		expect(liveKindFromUrl("https://h/jpg/image.jpg")).toBe("jpg");
		expect(liveKindFromUrl("https://h/cgi-bin/faststream.jpg")).toBe("jpg"); // no stream param
	});
});

describe("isRtspHost", () => {
	it("flags RTSP ports and RTSP fingerprints, spares HTTP cameras", () => {
		expect(isRtspHost(554, "Hikvision IP Camera")).toBe(true);
		expect(isRtspHost(8080, "Hipcam/HiSilicon-family (RTSP)")).toBe(true);
		expect(isRtspHost(80, "Axis M3027")).toBe(false);
		expect(isRtspHost(8080, null)).toBe(false);
	});
});
