import { expect, test } from "@playwright/test";

// The map page ships an inert SVG (the no-JS experience, see no-js.e2e.ts). With JS, geomap.js
// upgrades it to a d3 canvas: clustered dots, constant dot size, and country -> state borders
// that lazy-load as you zoom. Everything stays same-origin (no tile server), like the rest of
// the site. The projection is a plain equirectangular fit to the canvas, so a lng/lat maps to a
// canvas pixel linearly, which lets these tests aim at a known camera.
test.describe("map (JS canvas upgrade)", () => {
	const pxOf = (box: { x: number; y: number; width: number; height: number }, lng: number, lat: number) => ({
		x: box.x + ((lng + 180) / 360) * box.width,
		y: box.y + ((90 - lat) / 180) * box.height,
	});

	test("upgrades the SVG to a canvas and never leaves the origin", async ({ page, baseURL }) => {
		const offOrigin: string[] = [];
		page.on("request", (r) => {
			const u = r.url();
			if (/^https?:/.test(u) && !u.startsWith(baseURL as string)) offOrigin.push(u);
		});
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));

		await page.goto("/map");
		await page.waitForSelector("canvas.worldmap-canvas");
		// The inert SVG is retired once the canvas is live (its dot links live on every other page).
		await expect(page.locator("svg.worldmap")).toHaveCount(0);
		await expect(page.locator("canvas.worldmap-canvas")).toHaveCount(1);

		expect(offOrigin, "map must not request any third-party host (no tile server)").toEqual([]);
		expect(errors).toEqual([]);
	});

	test("zooming in lazy-loads that country's state borders", async ({ page }) => {
		await page.goto("/map");
		await page.waitForSelector("canvas.worldmap-canvas");
		await page.waitForTimeout(300);
		const box = await page.locator("canvas.worldmap-canvas").boundingBox();
		if (!box) throw new Error("no canvas box");

		// Arm the wait BEFORE zooming: states for a country only fetch once it's in view zoomed in.
		const states = page.waitForRequest(/\/geo\/admin1\/USA\.json/, { timeout: 8000 });
		const us = pxOf(box, -95, 39);
		await page.mouse.move(us.x, us.y);
		for (let i = 0; i < 22; i++) {
			await page.mouse.wheel(0, -120);
			await page.waitForTimeout(45);
		}
		await states; // throws (fails the test) if the sub-map never loads
	});

	test("clicking a camera dot navigates via htmx without a full reload", async ({ page }) => {
		await page.goto("/map");
		await page.waitForSelector("canvas.worldmap-canvas");
		await page.waitForTimeout(300);
		const box = await page.locator("canvas.worldmap-canvas").boundingBox();
		if (!box) throw new Error("no canvas box");

		// A fixture camera far from the others (San Francisco) is its own single dot at world zoom.
		const sf = pxOf(box, -122.3778, 37.7983);
		await page.mouse.move(sf.x, sf.y);
		await expect(page.locator(".map-tip")).toBeVisible(); // hovering a single dot shows its label
		// __stay rides on the window; it survives an htmx swap but a full reload wipes it.
		await page.evaluate(() => ((globalThis as unknown as { __stay: number }).__stay = 1));
		await page.mouse.click(sf.x, sf.y);

		await page.waitForURL(/\/(hosts|feeds|streams)\//);
		await expect(page.locator("main article")).toBeVisible();
		// The shell survived (htmx fragment swap, not a document reload).
		await expect(page.locator("nav.nav > a")).toHaveCount(8);
		expect(await page.evaluate(() => (globalThis as unknown as { __stay?: number }).__stay)).toBe(1);
	});

	test("a cluster that zoom can't split opens a list to reach every camera", async ({ page }) => {
		await page.goto("/map");
		await page.waitForSelector("canvas.worldmap-canvas");
		await page.waitForTimeout(300);
		const box = await page.locator("canvas.worldmap-canvas").boundingBox();
		if (!box) throw new Error("no canvas box");

		// Two fixture cameras share these exact coords, so they cluster at every zoom (geo-IP
		// co-location). Zoom in to isolate the pair, then clicking it must open a list, not a
		// bottomless zoom, so the cameras stay reachable.
		const sp = pxOf(box, 105.3, 61.5);
		await page.mouse.move(sp.x, sp.y);
		for (let i = 0; i < 16; i++) {
			await page.mouse.wheel(0, -120);
			await page.waitForTimeout(40);
		}
		await page.mouse.move(sp.x, sp.y);
		await page.waitForTimeout(60);
		await page.mouse.click(sp.x, sp.y);

		const list = page.locator(".map-list");
		await expect(list).toBeVisible();
		const links = list.locator("li a");
		expect(await links.count()).toBeGreaterThanOrEqual(2);

		await page.evaluate(() => ((globalThis as unknown as { __stay: number }).__stay = 1));
		await links.first().click();
		await page.waitForURL(/\/(hosts|feeds|streams)\//);
		await expect(page.locator("main article")).toBeVisible();
		expect(await page.evaluate(() => (globalThis as unknown as { __stay?: number }).__stay)).toBe(1);
	});

	test("the theme picker recolors the canvas without errors", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.goto("/map");
		await page.waitForSelector("canvas.worldmap-canvas");
		// Drive the real picker (assets/theme.js); geomap.js observes the <html> class and redraws.
		const sel = page.locator("#themeSel");
		for (const theme of ["light", "cctv", "dark"]) {
			await sel.selectOption(theme);
			await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
			await expect(page.locator("canvas.worldmap-canvas")).toHaveCount(1);
		}
		expect(errors).toEqual([]);
	});

	test("falls back to the plain SVG pan/zoom when the map libs fail to load", async ({ page }) => {
		await page.route("**/d3.min.js", (r) => r.abort());
		await page.goto("/map");
		await page.waitForTimeout(700);
		await expect(page.locator("canvas.worldmap-canvas")).toHaveCount(0);
		await expect(page.locator("svg.worldmap")).toHaveCount(1);

		// map.js still enhances the SVG: a wheel nudges the viewBox.
		const svg = page.locator("svg.worldmap");
		const before = await svg.getAttribute("viewBox");
		const box = await svg.boundingBox();
		if (!box) throw new Error("no svg box");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -300);
		await page.waitForTimeout(120);
		expect(await svg.getAttribute("viewBox")).not.toBe(before);
	});
});
