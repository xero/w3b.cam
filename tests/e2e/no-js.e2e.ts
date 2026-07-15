import { expect, test } from "@playwright/test";

// Runs only in the "no-js" project (javaScriptEnabled: false): the site must work as plain
// linked static pages with no htmx.
test.describe("progressive enhancement (no JS)", () => {
	test("pretty URLs load complete pages and card links navigate", async ({ page }) => {
		await page.goto("/gallery/1");
		await expect(page.locator("nav.nav > a")).toHaveCount(8);

		const href = await page.locator("a.card").first().getAttribute("href");
		expect(href).toBeTruthy();

		// Plain full-page navigation (no htmx) to the detail page.
		await page.goto(href as string);
		await expect(page.locator("main article")).toBeVisible();
	});
});
