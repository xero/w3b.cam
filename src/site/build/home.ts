// Homepage assembly helpers: per-kind card counts, which vendors earn a gallery this build,
// the featured-then-newest picker, and the blended-gallery newest-first comparator.

import type { Host, FeedCam } from "../render.ts";

/** Cards shown per kind on the homepage: the featured picks first, then the newest fill the rest. */
export const HOME_PER_KIND = 4;

/** How many of the HOME_PER_KIND cards are sampled at random from the featured set each build (rest fill from newest). */
export const HOME_FEATURED_PER_KIND = 2;

/** Rows shown in each homepage "top N" column (most-used tags, most-common cam makes). */
export const HOME_TOP_N = 10;

/**
 * The set of vendors that will get a `/fingerprints/<vendor>` gallery this build: a vendor
 * qualifies iff it has at least one visible host or feed. Computed straight from vendorRefs +
 * the already-filtered `hosts`/`feedCams` (both carry only rows with a screenshot), so it is
 * available before the --index-only early return — and matches the emptiness check the
 * vendor-gallery loop makes when it actually writes the pages.
 */
export function computeVendorsWithGallery(
	vendorRefs: { byVendor: Map<string, { hosts: Set<string>; feeds: Set<string> }> },
	hosts: Host[],
	feedCams: FeedCam[],
): Set<string> {
	const visibleHostIps = new Set(hosts.map((h) => h.ip));
	const visibleFeedIds = new Set(feedCams.map((c) => c.id));
	const out = new Set<string>();
	for (const [vendor, refs] of vendorRefs.byVendor) {
		const has =
			[...refs.hosts].some((ip) => visibleHostIps.has(ip)) || [...refs.feeds].some((id) => visibleFeedIds.has(id));
		if (has) out.add(vendor);
	}
	return out;
}

/**
 * Assemble one homepage row: resolve the featured `refs` against `byRef` (a pin
 * whose row is gone is skipped), then top up from `newest` until `limit` cards,
 * never repeating one (`keyOf` dedupes featured vs newest). With two live pins and
 * `newest` sorted newest-first, this yields the two featured then the two newest.
 */
export function pickHome<T>(refs: string[], byRef: Map<string, T>, newest: T[], keyOf: (item: T) => string, limit: number): T[] {
	const picked: T[] = [];
	const used = new Set<string>();
	const take = (item: T | undefined): void => {
		if (!item || picked.length >= limit) return;
		const k = keyOf(item);
		if (used.has(k)) return;
		used.add(k);
		picked.push(item);
	};
	for (const ref of refs) take(byRef.get(ref));
	for (const item of newest) take(item);
	return picked;
}

/** Newest-first comparator for the blended `{ ts, item }` gallery entries (ISO timestamps sort lexically). */
export const byNewest = (a: { ts: string }, b: { ts: string }): number => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
