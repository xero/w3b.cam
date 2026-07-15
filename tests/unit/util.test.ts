import { describe, expect, it } from "bun:test";
import type { WebcamMatch } from "../../src/core/types.ts";
import { escapeHtml, getScreenshot, isBlockedProduct, num, toRow } from "../../src/core/util.ts";

describe("escapeHtml", () => {
	it("escapes the five HTML-significant characters", () => {
		expect(escapeHtml(`<a href="x" b='y' & z>`)).toBe("&lt;a href=&quot;x&quot; b=&#39;y&#39; &amp; z&gt;");
	});
	it("returns '' for null/undefined", () => {
		expect(escapeHtml(null)).toBe("");
		expect(escapeHtml(undefined)).toBe("");
	});
	it("stringifies non-strings", () => expect(escapeHtml(42)).toBe("42"));
});

describe("num", () => {
	it("parses a positive int", () => expect(num("50")).toBe(50));
	it("returns 0 when absent", () => {
		expect(num(undefined)).toBe(0);
		expect(num("")).toBe(0);
	});
});

describe("isBlockedProduct", () => {
	it("blocks vnc / rdp case-insensitively and trimmed", () => {
		expect(isBlockedProduct("VNC")).toBe(true);
		expect(isBlockedProduct(" Remote Desktop Protocol ")).toBe(true);
	});
	it("allows real products and non-strings", () => {
		expect(isBlockedProduct("Hikvision IP Camera")).toBe(false);
		expect(isBlockedProduct(null)).toBe(false);
	});
});

describe("getScreenshot", () => {
	it("extracts data (whitespace stripped) and mime", () => {
		const ss = getScreenshot({ screenshot: { data: "AA AA\nBB", mime: "image/png", hash: 1 } } as WebcamMatch);
		expect(ss?.data).toBe("AAAABB");
		expect(ss?.mime).toBe("image/png");
	});
	it("defaults mime to image/jpeg", () => {
		expect(getScreenshot({ screenshot: { data: "AAAA" } } as WebcamMatch)?.mime).toBe("image/jpeg");
	});
	it("returns null when there is no usable data", () => {
		expect(getScreenshot({} as WebcamMatch)).toBeNull();
		expect(getScreenshot({ screenshot: { mime: "image/png" } } as WebcamMatch)).toBeNull();
	});
});

describe("toRow", () => {
	it("builds a cam row with id ip:port, sha256 ss_hash, and a display name", () => {
		const m = {
			ip_str: "1.2.3.4",
			port: 80,
			product: "X",
			hostnames: ["h.example.com"],
			domains: [],
			location: { latitude: 1, longitude: 2, city: "C" },
		} as WebcamMatch;
		const row = toRow(m, { data: "aGVsbG8=", mime: "image/png", hash: 0 });
		expect(row?.id).toBe("1.2.3.4:80");
		expect(row?.kind).toBe("cam");
		expect(row?.ss_base64).toBe("aGVsbG8=");
		expect(row?.ss_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.name).toBe("h.example.com");
	});
	it("returns null without an ip/port", () => {
		expect(toRow({ port: 80 } as WebcamMatch, { data: "x", mime: "image/png", hash: 0 })).toBeNull();
	});
});
