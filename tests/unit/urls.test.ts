import { describe, expect, it } from "bun:test";
import {
	diskOf,
	eventRoute,
	eventSlug,
	feedSlug,
	galleryPage,
	hostRoute,
	hostSlug,
	snipDiskOf,
	snipUrlOf,
	tagPage,
	tagSlug,
	urlOf,
	ytSlug,
} from "../../src/urls.ts";

describe("route -> artifact mapping", () => {
	it("maps the homepage (empty route) specially", () => {
		expect(diskOf("")).toBe("index.html");
		expect(snipDiskOf("")).toBe("index.snippet.html");
		expect(urlOf("")).toBe("/");
		expect(snipUrlOf("")).toBe("/index.snippet.html");
	});

	it("maps a nested route to clean folder URLs", () => {
		expect(diskOf("gallery/1")).toBe("gallery/1/index.html");
		expect(snipDiskOf("hosts/1.2.3.4")).toBe("hosts/1.2.3.4/index.snippet.html");
		expect(urlOf("gallery/1")).toBe("/gallery/1");
		expect(snipUrlOf("gallery/1")).toBe("/gallery/1/index.snippet.html");
	});
});

describe("hostSlug (traversal-safe, IPv6 folding)", () => {
	it("keeps IPv4 dotted", () => expect(hostSlug("194.94.76.131")).toBe("194.94.76.131"));
	it("folds IPv6 colons to hyphens and lowercases", () => expect(hostSlug("2001:DB8::1")).toBe("2001-db8--1"));
	it("drops traversal characters", () => {
		const slug = hostSlug("../../etc/passwd");
		expect(slug).not.toContain("..");
		expect(slug).not.toContain("/");
	});
	it("falls back to 'host' when nothing survives", () => expect(hostSlug("///")).toBe("host"));
});

describe("feedSlug", () => {
	it("strips the mjpeg- prefix so it reads like an IP", () => expect(feedSlug("mjpeg-38.79.156.188")).toBe("38.79.156.188"));
	it("keeps already-safe ids", () => expect(feedSlug("butler-oh_129.747")).toBe("butler-oh_129.747"));
	it("replaces hostile characters", () => expect(feedSlug("a/b c")).toBe("a-b-c"));
	it("falls back to 'feed'", () => expect(feedSlug("///")).toBe("feed"));
});

describe("ytSlug / eventSlug / tagSlug", () => {
	it("ytSlug prefixes yt- and keeps id chars", () => expect(ytSlug("aB_9-x")).toBe("yt-aB_9-x"));
	it("eventSlug lowercases + hyphenates", () => expect(eventSlug("I-376 Demolition!")).toBe("i-376-demolition"));
	it("eventSlug falls back to 'event'", () => expect(eventSlug("!!!")).toBe("event"));
	it("tagSlug lowercases + hyphenates", () => expect(tagSlug("Night View")).toBe("night-view"));
	it("tagSlug collapses non-alnum runs", () => expect(tagSlug("a  &  b")).toBe("a-b"));
	it("tagSlug falls back to 'untagged'", () => expect(tagSlug("!!!")).toBe("untagged"));
});

describe("route builders compose with slugs", () => {
	it("build detail + paginated routes", () => {
		expect(hostRoute(hostSlug("1.2.3.4"))).toBe("hosts/1.2.3.4");
		expect(eventRoute("I-376 Demo")).toBe("event/i-376-demo");
		expect(tagPage(tagSlug("Night View"), 2)).toBe("tags/night-view/2");
		expect(galleryPage(3)).toBe("gallery/3");
	});
});
