import { describe, expect, it } from "bun:test";
import { BANNER, FRAMES, animated } from "../../src/core/spinner.ts";

describe("FRAMES", () => {
	// line() clips the message assuming a one-column mark
	it("is all single braille cells", () => {
		for (const f of FRAMES) expect(f).toMatch(/^[⠀-⣿]$/);
	});
});

describe("animated", () => {
	it("is on by default in a terminal", () => {
		expect(animated({}, true)).toBe(true);
		expect(animated({ CI: "" }, true)).toBe(true);
	});
	it("turns off for a truthy CI, case-insensitively", () => {
		for (const CI of ["1", "true", "TRUE", "yes", "on", " true "]) expect(animated({ CI }, true)).toBe(false);
	});
	it("stays on for a falsy CI", () => {
		for (const CI of ["0", "false", "no", "off"]) expect(animated({ CI }, true)).toBe(true);
	});
	it("is off when stderr is not a terminal", () => expect(animated({}, false)).toBe(false));
});

describe("BANNER", () => {
	const rows = BANNER.replace(/\x1b\[[\d;]*m/g, "").split("\n");
	// a wider row wraps on an 80-column terminal and tears the art apart
	it("fits 80 columns", () => {
		for (const r of rows) expect([...r].length).toBeLessThanOrEqual(80);
	});
	// a plain template literal eats these, and a `\${` leaves the ESC uninterpolated
	it("keeps its backslashes and escapes", () => {
		expect(BANNER).toContain(String.raw`/\.----__/`);
		expect(BANNER).not.toContain("${");
	});
	// Bun turns non-ASCII inside String.raw into literal \uXXXX text
	it("keeps its block characters", () => {
		expect(BANNER).toContain("▄▄▄▄");
		expect(BANNER).not.toContain("\\u");
	});
	it("resets color at the end of every drawn row", () => {
		for (const r of BANNER.split("\n")) if (r.includes("\x1b")) expect(r).toEndWith("\x1b[0m");
	});
});
