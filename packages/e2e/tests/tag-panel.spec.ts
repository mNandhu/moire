import { expect, test } from "@playwright/test";

test("a tag opens its panel, and the panel opens the gallery on it", async ({ page }) => {
  await page.goto("/tags");
  // Seven images carry solo: the six generated ones and the weighted one.
  await page.getByRole("button", { name: "solo 7 images" }).click();
  await expect(page).toHaveURL(/[?&]tag=solo(&|$)/);

  const panel = page.getByRole("complementary", { name: "Tag solo" });
  await expect(panel.getByText("7 images", { exact: false }).first()).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Images · 7" })).toBeVisible();

  await panel.getByRole("link", { name: "Open in gallery" }).click();
  await expect(page).toHaveURL(/\/\?tags=any%3Asolo/);
  await expect(page.locator("[data-tile-index]")).toHaveCount(7);
});

test("closing the panel leaves the tag list", async ({ page }) => {
  await page.goto("/tags?tag=solo");
  const panel = page.getByRole("complementary", { name: "Tag solo" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close tag details" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]tag=/);
});
