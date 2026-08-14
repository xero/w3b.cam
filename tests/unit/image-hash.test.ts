import { describe, expect, it } from "bun:test";
import { isImageHash, normalizeImageHash } from "../../src/db/db.ts";

// normalizeImageHash is the linchpin: it maps whatever an operator pastes (a 16-hex hash
// from an /img/<hash>.jpg URL, a full sha256, with/without extension or casing) onto the
// canonical 16-hex key the blacklist and the ingest guard compare against.
describe("normalizeImageHash", () => {
	it("accepts a bare 16-hex hash", () => {
		expect(normalizeImageHash("1e5a6c3a27892c05")).toBe("1e5a6c3a27892c05");
	});

	it("lowercases and trims", () => {
		expect(normalizeImageHash("  1E5A6C3A27892C05  ")).toBe("1e5a6c3a27892c05");
	});

	it("strips a pasted image extension", () => {
		expect(normalizeImageHash("1e5a6c3a27892c05.jpg")).toBe("1e5a6c3a27892c05");
	});

	it("folds a full 64-hex sha256 to its first 16 (matching the baker)", () => {
		const full = "1e5a6c3a27892c05" + "f".repeat(48);
		expect(normalizeImageHash(full)).toBe("1e5a6c3a27892c05");
	});

	it("rejects non-hashes (IP, hostname, wrong length, non-hex)", () => {
		for (const bad of ["1.2.3.4", "cloudzy.com", "deadbeef", "1e5a6c3a27892c0", "1e5a6c3a27892c0g", ""]) {
			expect(normalizeImageHash(bad)).toBeNull();
		}
	});
});

describe("isImageHash", () => {
	it("routes 16- and 64-hex to the image path, everything else away from it", () => {
		expect(isImageHash("1e5a6c3a27892c05")).toBe(true);
		expect(isImageHash("1e5a6c3a27892c05" + "0".repeat(48))).toBe(true);
		expect(isImageHash("1.2.3.4")).toBe(false); // IP
		expect(isImageHash("cloudzy.com")).toBe(false); // hostname
	});
});
