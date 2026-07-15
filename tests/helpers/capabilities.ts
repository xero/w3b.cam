// Deterministic probes for the capabilities the network-bound scripts need. The shallow
// tests use these with it.skipIf(...) so absent capabilities show as skipped (not failed),
// and the run-end banner (coverage-report.ts) lists what was missing.

export interface Capabilities {
	/** YOUTUBE_API_KEY — needed by `import --youtube` and Osiris YouTube cams. */
	youtubeKey: boolean;
	/** SHODANTOKEN — needed by `scrape` and `preflight`. */
	shodanToken: boolean;
	/** ffmpeg on PATH — needed to grab frames for `import --mjpeg/--hls` and Osiris feeds. */
	ffmpeg: boolean;
	/** Outbound network — needed by every non-Shodan-JSON ingest path, plus `sync`. */
	network: boolean;
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		await fetch(url, { method: "HEAD", signal: ctrl.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

function isSet(name: string): boolean {
	const v = process.env[name];
	return !!v && v.trim() !== "";
}

let cached: Capabilities | undefined;

export async function detectCapabilities(): Promise<Capabilities> {
	if (cached) return cached;
	cached = {
		youtubeKey: isSet("YOUTUBE_API_KEY"),
		shodanToken: isSet("SHODANTOKEN"),
		ffmpeg: !!Bun.which("ffmpeg"),
		network: await reachable("https://example.com", 2000),
	};
	return cached;
}
