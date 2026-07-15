import { expect, test } from "@playwright/test";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("htmx navigation", () => {
	test("clicking a card swaps <main>, pushes the pretty URL, and Back restores", async ({ page }) => {
		await page.goto("/gallery/1");
		const card = page.locator("a.card").first();
		const href = await card.getAttribute("href");
		expect(href).toBeTruthy();

		await card.click();

		// htmx pushed the pretty URL and swapped a detail page into <main>...
		await expect(page).toHaveURL(new RegExp(`${escapeRe(href as string)}$`));
		await expect(page.locator("main article")).toBeVisible();
		// ...while the shell (nav) persisted, proving it was a fragment swap, not a reload.
		await expect(page.locator("nav.nav > a")).toHaveCount(8);

		await page.goBack();
		await expect(page).toHaveURL(/\/gallery\/1$/);
		await expect(page.locator("a.card").first()).toBeVisible();
	});
});
