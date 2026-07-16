// Build-time CRT config for the opt-in "cctv" theme (vault66-crt-effect).
//
// computeCrt() is a pure function of the options, so we run it here at bake time and emit
// only its result into out/crt-config.js (window.__CRT). That means ZERO library JS ships
// to the browser — the client (assets/theme.js) just mounts the precomputed class names +
// custom-property styles as a fixed, pointer-events:none viewport overlay. The matching
// classes live in the vendored dist stylesheet (copied to out/crt.css from the same
// installed version), so the precompute and the CSS never drift.

import type { CRTOptions } from "vault66-crt-effect/core";

/** The vault66 playground output for the cctv look: apple2 phosphor green, gentle sweep,
 *  scanlines, noise, vignette, subtle curvature. */
export const CRT_CONFIG: CRTOptions = {
	preset: "apple2",
	scanlineOpacity: 0.23,
	enableSweep: true,
	sweepDuration: 7,
	sweepThickness: 16,
	sweepColor: "rgba(120, 220, 80, 0.5)",
	vignetteIntensity: 0.5,
	curvatureIntensity: 0.5,
	enableNoise: true,
	noiseOpacity: 0.45,
};

/** Serialized `window.__CRT` payload for out/crt-config.js. Only the wrapper (class +
 *  custom-property style bag) and the overlay layer classes are needed — the client mounts
 *  the wrapper as a fixed overlay and never wraps page content, so `inner` is dropped. The
 *  import is dynamic so a missing dependency degrades to an inert theme instead of aborting
 *  the whole bake (the caller guards on the dist file existing). */
export async function crtConfigJs(): Promise<string> {
	const { computeCrt } = await import("vault66-crt-effect/core");
	const { wrapper, overlays } = computeCrt(CRT_CONFIG);
	return `window.__CRT=${JSON.stringify({ wrapper, overlays })};\n`;
}
