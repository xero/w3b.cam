// The loud run-end "coverage gaps" banner. Network-bound scripts can only be exercised
// shallowly (arg-parse + error paths) when a capability is absent; this enumerates what
// was missing and which scripts were therefore not run end-to-end. It NEVER fails the run.

import { detectCapabilities } from "./capabilities.ts";

interface Gap {
	cap: string;
	why: string;
	scripts: string[];
}

export async function printCoverageBanner(): Promise<void> {
	const caps = await detectCapabilities();
	const gaps: Gap[] = [];
	if (!caps.network)
		gaps.push({ cap: "network", why: "no outbound network", scripts: ["scrape", "preflight", "sync", "import --youtube/--mjpeg/--hls", "osiris"] });
	if (!caps.shodanToken)
		gaps.push({ cap: "SHODANTOKEN", why: "env var unset", scripts: ["scrape", "preflight"] });
	if (!caps.youtubeKey)
		gaps.push({ cap: "YOUTUBE_API_KEY", why: "env var unset", scripts: ["import --youtube"] });
	if (!caps.ffmpeg)
		gaps.push({ cap: "ffmpeg", why: "not on PATH", scripts: ["import --mjpeg/--hls", "osiris"] });

	const bar = "=".repeat(74);
	console.log(`\n${bar}`);
	console.log("  SHALLOW COVERAGE - network-bound scripts (scrape, preflight, sync, osiris,");
	console.log("  import --youtube/--mjpeg/--hls) are tested only at the arg/error level here.");
	console.log("  Running them end-to-end spends credits / hits live services, so it is manual.");
	if (gaps.length === 0) {
		console.log(bar);
		console.log("  All capabilities present. Run `TEST_LIVE=1 bun run test` to exercise the");
		console.log("  one safe live check (preflight credit balance; spends no credits).");
		console.log(`${bar}\n`);
		return;
	}
	console.log(bar);
	console.log("  !!  MISSING capabilities (you could not fully run these even manually):");
	for (const g of gaps) {
		console.log(`  * ${g.cap}  (${g.why})`);
		console.log(`      affects: ${g.scripts.join(", ")}`);
	}
	console.log(bar);
	console.log("  Not test failures - provide the missing env vars / ffmpeg / network to");
	console.log("  exercise those script paths end-to-end.");
	console.log(`${bar}\n`);
}

if (import.meta.main) await printCoverageBanner();
