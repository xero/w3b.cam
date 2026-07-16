import { expect, test } from "@playwright/test";

// Runs in the "chromium" project (JS on). The theme picker is written into the header by
// assets/theme.js; selecting a style toggles a class on <html> and persists it in
// localStorage, restored before paint by the shell's inline head script. Assertions go
// through Playwright's locator APIs (toHaveCSS / boundingBox) so the specs stay clear of
// browser globals the test tsconfig doesn't type (no DOM lib).

const BG_DARK = "rgb(15, 17, 23)"; // --bg #0f1117
const BG_LIGHT = "rgb(239, 239, 239)"; // --bg #efefef

test.describe("manual theme picker", () => {
	test("JS injects the picker into the header", async ({ page }) => {
		await page.goto("/");
		const aside = page.locator("body > header #theme");
		await expect(aside).toBeAttached();
		await expect(aside.locator("select#themeSel")).toBeAttached();
	});

	test("selecting a style forces the theme past the OS preference", async ({ page }) => {
		await page.goto("/");
		const sel = page.locator("#themeSel");
		const html = page.locator("html");
		const body = page.locator("body");

		await sel.selectOption("light");
		await expect(html).toHaveClass(/\blight\b/);
		await expect(body).toHaveCSS("background-color", BG_LIGHT);

		await sel.selectOption("dark");
		await expect(html).toHaveClass(/\bdark\b/);
		await expect(body).toHaveCSS("background-color", BG_DARK);

		// The empty "Theme" option clears the override (Auto / follow the OS).
		await sel.selectOption("");
		await expect(html).not.toHaveClass(/\b(light|dark)\b/);
	});

	test("the choice persists across reload and htmx nav; clearing persists too", async ({ page }) => {
		await page.goto("/");
		await page.locator("#themeSel").selectOption("light");

		// Full reload: the inline head script restores it before paint; control reflects it.
		await page.reload();
		await expect(page.locator("html")).toHaveClass(/\blight\b/);
		await expect(page.locator("#themeSel")).toHaveValue("light");

		// htmx nav swaps only <main>, so <html>'s class survives navigation.
		await page.locator("nav.nav > a").first().click();
		await expect(page.locator("html")).toHaveClass(/\blight\b/);

		// Clearing writes through storage too: after a reload the override is gone.
		await page.locator("#themeSel").selectOption("");
		await page.reload();
		await expect(page.locator("html")).not.toHaveClass(/\b(light|dark)\b/);
		await expect(page.locator("#themeSel")).toHaveValue("");
	});

	// Below ~620px the picker must ride the title row with the nav wrapped below — checked
	// at 400px and at 600px (the latter regressed before the 620px breakpoint fix).
	for (const width of [400, 600]) {
		test(`at ${width}px the picker rides the title row, the nav wraps below`, async ({ page }) => {
			await page.setViewportSize({ width, height: 800 });
			await page.goto("/");
			const brand = (await page.locator("body > header .brand").boundingBox())!;
			const aside = (await page.locator("body > header #theme").boundingBox())!;
			const nav = (await page.locator("body > header nav.nav").boundingBox())!;

			// Picker shares the brand's row (their vertical spans overlap) and sits above the nav.
			expect(aside.y).toBeLessThan(brand.y + brand.height);
			expect(aside.y + aside.height).toBeGreaterThan(brand.y);
			expect(aside.y).toBeLessThan(nav.y);
		});
	}
});

test.describe("cctv theme (CRT overlay)", () => {
	const overlay = (p: import("@playwright/test").Page) => p.locator("#crt-overlay");

	test("selecting cctv mounts a fixed, click-through overlay with all layers", async ({ page }) => {
		await page.goto("/");
		await page.locator("#themeSel").selectOption("cctv");

		await expect(page.locator("html")).toHaveClass(/\bcctv\b/);
		await expect(overlay(page)).toBeAttached();
		await expect(overlay(page)).toHaveCSS("position", "fixed");
		await expect(overlay(page)).toHaveCSS("pointer-events", "none");
		// crt-curvature + crt-noise + crt-vignette (sweep/scanlines are wrapper pseudo-elements).
		await expect(overlay(page).locator("> div")).toHaveCount(3);
	});

	test("switching away removes the overlay", async ({ page }) => {
		await page.goto("/");
		await page.locator("#themeSel").selectOption("cctv");
		await expect(overlay(page)).toHaveCount(1);

		await page.locator("#themeSel").selectOption("dark");
		await expect(overlay(page)).toHaveCount(0);
		await expect(page.locator("html")).not.toHaveClass(/\bcctv\b/);
	});

	test("live playback renders above the CRT glass (previews stay under)", async ({ page }) => {
		// This feed detail page carries a live img[data-refresh] (auto-refreshing snapshot).
		await page.goto("/feeds/38.79.156.188");
		await page.locator("#themeSel").selectOption("cctv");

		const live = page.locator("img[data-refresh], img[data-mjpeg], .live-video, .yt-embed").first();
		await expect(live).toHaveCSS("position", "relative");

		const zed = (l: import("@playwright/test").Locator) =>
			l.evaluate((el) => Number(el.ownerDocument.defaultView!.getComputedStyle(el).zIndex));
		expect(await zed(live)).toBeGreaterThan(await zed(overlay(page)));
	});

	test("the overlay survives htmx nav and a full reload (mounted once)", async ({ page }) => {
		await page.goto("/");
		await page.locator("#themeSel").selectOption("cctv");

		// htmx swaps only <main>; the overlay is a body-level sibling, so it persists.
		await page.locator("nav.nav > a").first().click();
		await expect(overlay(page)).toHaveCount(1);

		// Reload: head script restores the class before paint, theme.js re-mounts once.
		await page.reload();
		await expect(page.locator("#themeSel")).toHaveValue("cctv");
		await expect(overlay(page)).toHaveCount(1);
	});
});
