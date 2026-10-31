import { expect, test } from "@playwright/test";
import { API, sandbox } from "./helpers";

const tiles = "[data-tile-index]";

test("the feed pages in the rest of the library on scroll", async ({ page }) => {
  const pages: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === `${API}/images`) pages.push(url.searchParams.get("cursor") ?? "");
  });
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();
  expect(pages[0]).toBe("");

  // The newest first: the six generated images lead, the filler follows.
  const last = page.locator(`[data-tile-index="${sandbox().images - 1}"]`);
  await page.locator(tiles).first().hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      return last.count();
    })
    .toBe(1);
  // The rest came from a keyset page: a request carrying the server's cursor.
  expect(pages.some((c) => c !== "")).toBe(true);
});

test("searching a tag filters the gallery and the URL", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();

  const search = page.getByPlaceholder("Search tags, outfits, lora:, embedding:…");
  await search.fill("blue_hair");
  await search.press("Enter");

  // A typed tag matches any kind (AI, manual or prompt).
  await expect(page).toHaveURL(/[?&]tags=any%3Ablue_hair(&|$)/);
  await expect(page.locator(tiles)).toHaveCount(2);

  // The URL alone rebuilds the same view.
  await page.reload();
  await expect(page.locator(tiles)).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Remove blue[_ ]hair$/ })).toBeVisible();
});

test("selection mode shows the tile checkboxes, from the toolbar and the phone menu", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();
  const checkboxes = page.getByRole("button", { name: "Select", exact: true });
  await expect(checkboxes).toHaveCount(0);

  await page.getByRole("button", { name: "Select images" }).click();
  await expect(checkboxes.first()).toBeVisible();
  await page.getByRole("button", { name: "Done selecting" }).click();
  await expect(checkboxes).toHaveCount(0);

  // Phones fold grouping and selection into the View options menu.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitem", { name: "Select images" }).click();
  await expect(checkboxes.first()).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(checkboxes).toHaveCount(0);
});
