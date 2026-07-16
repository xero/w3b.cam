import { expect, test } from "@playwright/test";

// Feed/motion detail pages must never hit the upstream feed until the user opts in. Every
// auto-playing kind (jpg snapshot, mjpeg, mp4, hls) renders as a click-to-load `.facade`
// with the live element held inert inside a <template> — mirroring the YouTube stream
// facade — so page load makes zero cross-origin requests. Fixture feeds live on *.example*
// hosts (see tests/fixtures/rows.ts), so any hit to one is the feed going live.
test.describe("feed facades (opt-in playback)", () => {
	const UPSTREAM = /example\.test|example-cams\.test/;

	const cases = [
		{ slug: "38.79.156.188", live: "img[data-refresh]", label: "jpg snapshot" },
		{ slug: "hls-demo-bridge", live: "video[data-hls]", label: "hls stream" },
		{ slug: "butler-oh-129-747", live: "video.live-video", label: "mp4 video" },
	];

	for (const c of cases) {
		test(`${c.label}: inert until the facade is clicked`, async ({ page }) => {
			const upstream: string[] = [];
			page.on("request", (r) => {
				if (UPSTREAM.test(r.url())) upstream.push(r.url());
			});

			await page.goto(`/feeds/${c.slug}`);

			// On load: a facade preview, no live element mounted, no upstream request.
			const facade = page.locator(".facade");
			await expect(facade).toBeVisible();
			await expect(page.locator(c.live)).toHaveCount(0);
			expect(upstream, "no upstream feed request before opt-in").toEqual([]);

			// Opt in: the real live element mounts in place of the facade.
			await facade.click();
			await expect(page.locator(c.live)).toHaveCount(1);
			await expect(facade).toHaveCount(0);
		});
	}

	test("no JS: the facade is a plain link to the view-live URL", async ({ page }) => {
		// Even the facade markup degrades — it's an <a> to the feed's view-live target, so a
		// no-JS click just opens the feed (same as the button beneath it). Here we only assert
		// the href is present and points off-site; the no-js project covers navigation broadly.
		await page.goto("/feeds/38.79.156.188");
		const href = await page.locator(".facade").getAttribute("href");
		expect(href).toMatch(UPSTREAM);
	});
});
