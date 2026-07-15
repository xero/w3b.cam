import { expect, test } from "@playwright/test";

test.describe("homepage + shell", () => {
	test("renders with the site title, a visible main, and 8 nav links", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveTitle(/w3b\.cam/);
		await expect(page.locator("main")).toBeVisible();
		await expect(page.locator("nav.nav > a")).toHaveCount(8);
	});

	test("every nav link resolves (200)", async ({ page, request }) => {
		await page.goto("/");
		const hrefs = await page
			.locator("nav.nav > a")
			.evaluateAll((els) => els.map((e) => e.getAttribute("href")).filter((h): h is string => !!h));
		expect(hrefs.length).toBe(8);
		for (const h of hrefs) expect((await request.get(h)).status(), h).toBe(200);
	});

	test("syndication feeds are served", async ({ request }) => {
		for (const f of ["/rss.xml", "/atom.xml"]) {
			expect((await request.get(f)).status(), f).toBe(200);
		}
	});
});
