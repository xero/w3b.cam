import { describe, expect, it } from "bun:test";
import { table, took, type Section } from "../../src/core/table.ts";

const ROWS: Section[] = [
	["gallery", 14211, 1777],
	["hosts", 6911, 864],
	["feeds", 7175, 897],
	["streams", 125, 16],
	["vendors", 32, 808],
	["tags", 71, 1908],
	["map", 12446, 1],
];
const STATS = [
	" ┌┄──────┄─╤┄────┄─╤┄─────┄┐",
	" ┆ section ┆ items ┆ pages ┆",
	" ╟┄──────┄─╬┄────┄─╬┄─────┄╢",
	" ┆ gallery ┆ 14211 ┆ 1777  ┆",
	" │ hosts   │ 6911  │ 864   │",
	" │ feeds   │ 7175  │ 897   │",
	" │ streams │ 125   │ 16    │",
	" │ vendors │ 32    │ 808   │",
	" │ tags    │ 71    │ 1908  │",
	" ┆ map     ┆ 12446 ┆ 1     ┆",
	" ╟┄──────┄─╩┄────┄─╩┄─────┄╢",
];

describe("table", () => {
	it("draws the dev summary", () => {
		expect(table([took(105_000), "dev server running at", "http://localhost:1337"], ROWS)).toBe([
			...STATS,
			" ┆  ✓ build time: 1m 45s   ┆",
			" │  dev server running at  │",
			" ┆  http://localhost:1337  ┆",
			" └┄───────────────────────┄┘",
		].join("\n"));
	});
	it("draws the bake summary", () => {
		expect(table([took(105_000), "to preview the site", "run: `bun serve`"], ROWS)).toBe([
			...STATS,
			" ┆  ✓ build time: 1m 45s   ┆",
			" │  to preview the site    │",
			" ┆  run: `bun serve`       ┆",
			" └┄───────────────────────┄┘",
		].join("\n"));
	});
	it("draws a bare footer box without rows, staggering a two-row run", () => {
		expect(table(["preview server running at", "http://localhost:1337"])).toBe([
			" ┌┄───────────────────────────┄┐",
			" ┆  preview server running at  │",
			" │  http://localhost:1337      ┆",
			" └┄───────────────────────────┄┘",
		].join("\n"));
	});
	it("stretches the last column to a wider footer, and the footer to a wider table", () => {
		for (const t of [table(["http://localhost:13370"], ROWS), table(["x"], [["hosts", 1234567, 1]])]) {
			const ws = t.split("\n").map((l) => l.length);
			expect(new Set(ws).size).toBe(1);
		}
		expect(table(["http://localhost:13370"], ROWS)).toContain(" ┆ pages  ┆");
	});
});

describe("took", () => {
	it("spells out seconds, then minutes", () => {
		expect(took(9_400)).toBe("✓ build time: 9s");
		expect(took(65_000)).toBe("✓ build time: 1m 05s");
	});
});
