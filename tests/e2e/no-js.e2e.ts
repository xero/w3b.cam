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

	test("the JS-only theme picker is never in the server-rendered HTML", async ({ page }) => {
		await page.goto("/");
		await expect(page.locator("#theme")).toHaveCount(0);
	});

	test("the map is an inert SVG of real dot links, never a canvas", async ({ page }) => {
		await page.goto("/map");
		// The fancy canvas is a JS upgrade; with no JS the SVG world map stays, and its dots are
		// real links to each camera's detail page.
		await expect(page.locator("canvas.worldmap-canvas")).toHaveCount(0);
		await expect(page.locator("svg.worldmap")).toHaveCount(1);
		const dot = page.locator("svg.worldmap .dots a").first();
		const href = await dot.getAttribute("href");
		expect(href).toBeTruthy();

		await page.goto(href as string);
		await expect(page.locator("main article")).toBeVisible();
	});
});
