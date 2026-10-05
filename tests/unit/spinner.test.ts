import { describe, expect, it } from "bun:test";
import { FRAMES, animated } from "../../src/core/spinner.ts";

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
