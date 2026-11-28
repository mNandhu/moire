import { expect, test } from "@playwright/test";
import { API, imageByPath } from "./helpers";

// The image view names what it was opened under, beside Back.
const context = (page: import("@playwright/test").Page) => page.getByRole("note", { name: "Viewing" });
// The page it was opened on, then what on it.
const TOP_RATED = /^Discover\s*\/\s*Top rated$/;

test("an image opened from Discover's Top rated says so, image after image, and leads back", async ({ page, request }) => {
  // Four top rated images: a shelf needs that many to show.
  for (const part of ["filler_007", "filler_008", "filler_009", "filler_010"]) {
    const { _id } = await imageByPath(request, part);
    const scored = await request.post(`${API}/images/${encodeURIComponent(_id)}/score`, { data: { score: 5 } });
    expect(scored.ok()).toBe(true);
  }

  await page.goto("/discover");
  const top = page.getByRole("region", { name: "Top rated" });
  const first = top.getByRole("link", { name: /\.png$/ }).first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/image\//);
  await expect(context(page)).toHaveText(TOP_RATED);

  // Stepping keeps it, and so does a reload.
  const opened = page.url();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await expect(page).not.toHaveURL(opened);
  await expect(context(page)).toHaveText(TOP_RATED);
  await page.reload();
  await expect(context(page)).toHaveText(TOP_RATED);

  // The page's name goes back to it.
  await context(page).getByRole("button", { name: "Discover", exact: true }).click();
  await expect(page).toHaveURL(/\/discover$/);
});

test("an image opened from a filtered gallery names the filter, an unfiltered one nothing", async ({ page }) => {
  await page.goto("/?tags=any%3Asmile");
  await page.locator("[data-tile-index]").first().click();
  await expect(page).toHaveURL(/\/image\//);
  await expect(context(page)).toHaveText(/^All Images\s*\/\s*smile$/);
  await page.keyboard.press("Escape");

  await page.goto("/");
  await page.locator("[data-tile-index]").first().click();
  await expect(page).toHaveURL(/\/image\//);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeVisible();
  await expect(context(page)).toHaveCount(0);
});
