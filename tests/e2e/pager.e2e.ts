import { expect, test } from "@playwright/test";

// The fixture seeds >8 feeds (PAGE_SIZE = 8), so /feeds paginates into 2 pages.
test.describe("pager", () => {
	test("page 1 disables the first/prev control and links to a working page 2", async ({ page }) => {
		await page.goto("/feeds/1");
		const pager = page.locator("nav.pager[aria-label='Pagination']");
		await expect(pager).toBeVisible();

		// On page 1 there is at least one disabled control (first/prev).
		await expect(pager.locator("button.btn[disabled]").first()).toBeVisible();

		// A link to page 2 exists; clicking it navigates there via htmx.
		const next = pager.locator("a.btn[href='/feeds/2']").first();
		await expect(next).toBeVisible();
		await next.click();
		await expect(page).toHaveURL(/\/feeds\/2$/);
		await expect(page.locator("a.card").first()).toBeVisible();
	});
});
