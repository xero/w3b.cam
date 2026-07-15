import { expect, test } from "@playwright/test";
import { extractBgUrls, extractImgSrcs, extractInternalLinks } from "../helpers/crawl.ts";

test.describe("no broken internal links", () => {
	test("crawl every internal href + hx-get target; all resolve, sampled images too", async ({ request }) => {
		const seen = new Set<string>();
		const queue: string[] = ["/"];
		const broken: string[] = [];
		const assets = new Set<string>();

		while (queue.length > 0 && seen.size < 500) {
			const url = queue.shift() as string;
			if (seen.has(url)) continue;
			seen.add(url);

			const res = await request.get(url);
			if (res.status() !== 200) {
				broken.push(`${url} -> ${res.status()}`);
				continue;
			}
			if (!(res.headers()["content-type"] ?? "").includes("html")) continue;

			const html = await res.text();
			const { hrefs, hxGets } = extractInternalLinks(html);
			for (const h of [...hrefs, ...hxGets]) if (!seen.has(h)) queue.push(h);
			for (const a of [...extractImgSrcs(html), ...extractBgUrls(html)]) assets.add(a);
		}

		expect(broken, "broken internal links").toEqual([]);
		expect(seen.size, "crawled more than a couple pages").toBeGreaterThan(10);

		// Spot-check that referenced image assets resolve.
		const brokenAssets: string[] = [];
		for (const a of [...assets].slice(0, 20)) {
			if ((await request.get(a)).status() !== 200) brokenAssets.push(a);
		}
		expect(brokenAssets, "broken image assets").toEqual([]);
	});
});
