// Refresh-cadence + build-time helpers: derive the header's "fresh every N" cadence from
// the scrape workflow's cron, and format the build timestamp. No deps beyond Bun.file.

/** Scrape workflow, read at build time so the site surfaces its own cron cadence. */
const SCRAPE_WORKFLOW = ".github/workflows/scrape.yml";
/** Cadence shown when the workflow is missing or its cron is unrecognized. */
const DEFAULT_INTERVAL = "6 hrs";

/** Build time as "YYYY-MM-DD @ HH:MM" in UTC (the CI bake runs in UTC). */
export function formatBuiltAt(d: Date): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} @ ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Human cadence from a 5-field cron: a step in the hour field ("0 */6 * * *")
// yields "6 hrs"; a step in the minute field ("*/30 * * * *") yields "30 min"; a
// single fixed hour yields "24 hrs". Returns null if unrecognized.
function cronToInterval(expr: string): string | null {
	const f = expr.trim().split(/\s+/);
	const min = f[0];
	const hour = f[1];
	if (!min || !hour) return null;
	if (hour.startsWith("*/")) {
		const n = Number(hour.slice(2));
		if (n > 0) return `${n} hr${n === 1 ? "" : "s"}`;
	}
	if (hour === "*" && min.startsWith("*/")) {
		const n = Number(min.slice(2));
		if (n > 0) return `${n} min`;
	}
	if (hour === "*") return "1 hr";
	if (/^\d+$/.test(hour)) return "24 hrs";
	return null;
}

/**
 * Human refresh cadence derived from the scrape workflow's cron, so the header
 * self-updates if the schedule changes. Reads the first `cron:` line with a regex
 * (the repo has no YAML dep) and falls back to the documented six hours.
 */
export async function readScrapeInterval(): Promise<string> {
	try {
		const yml = await Bun.file(SCRAPE_WORKFLOW).text();
		const expr = yml.match(/cron:\s*['"]([^'"]+)['"]/)?.[1];
		return (expr && cronToInterval(expr)) || DEFAULT_INTERVAL;
	} catch {
		return DEFAULT_INTERVAL;
	}
}
