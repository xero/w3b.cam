// Box-drawn summaries for `bun bake`, `bun dev`, and `bun serve`: a stats table over a text
// footer, every column fitted to its widest cell. Plain text, so unlike the banner and
// spinner it still prints under CI and into pipes.

import { clock } from "./spinner.ts";

/** One stats row: a baked section with its item and page counts. */
export type Section = [name: string, items: number, pages: number];

const HEAD = ["section", "items", "pages"];

/** The footer's first line once a bake finishes. */
export const took = (ms: number): string => `✓ build time: ${clock(ms, " ")}`;

// ┄ caps each stretch of a rule: one right after a corner or junction, one a cell short of
// the next junction, and flush against a closing corner.
const rule = (l: string, j: string, r: string, ws: number[]): string =>
	` ${l}${ws.map((w, i) => (i < ws.length - 1 ? `┄${"─".repeat(w - 3)}┄─` : `┄${"─".repeat(w - 2)}┄`)).join(j)}${r}`;

// Rows echo it: ┆ on the first and last row of each run, │ between. A two-row run staggers
// them (top left, bottom right) so neither side is all dashes.
const dashed = (i: number, n: number, right: boolean): boolean => (n === 2 ? i === +right : i === 0 || i === n - 1);
const run = (rows: string[][], ws: number[]): string[] =>
	rows.map((r, i) => {
		const [l, rt] = [false, true].map((s) => (dashed(i, rows.length, s) ? "┆" : "│"));
		return ` ${l}${r.map((c, k) => ` ${c.padEnd(ws[k]! - 1)}`).join(l)}${rt}`;
	});

/** The section table, when there are rows, over a footer box; the narrower of the two stretches to match. */
export function table(foot: string[], rows: Section[] = []): string {
	const cells = [HEAD, ...rows.map((r) => r.map(String))];
	const ws = rows.length ? HEAD.map((_, k) => Math.max(...cells.map((r) => r[k]!.length)) + 2) : [];
	const need = Math.max(...foot.map((f) => f.length)) + 4, have = ws.reduce((a, w) => a + w + 1, -1);
	if (need > have && ws.length) ws[ws.length - 1]! += need - have;
	const w = Math.max(need, have);
	const top = ws.length
		? [rule("┌", "╤", "┐", ws), ...run(cells.slice(0, 1), ws), rule("╟", "╬", "╢", ws), ...run(cells.slice(1), ws), rule("╟", "╩", "╢", ws)]
		: [rule("┌", "", "┐", [w])];
	return [...top, ...run(foot.map((f) => [` ${f}`]), [w]), rule("└", "", "┘", [w])].join("\n");
}
