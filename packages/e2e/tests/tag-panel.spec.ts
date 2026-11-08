import { expect, test } from "@playwright/test";
import { API } from "./helpers";

test("a tag opens its panel, and the panel opens the gallery on it", async ({ page, request }) => {
  // The fixture images carrying solo, plus any Generate run whose prompt had
  // it (the fake ComfyUI saves the prompt like the real one): read, not
  // assumed, so the spec holds whichever specs ran before it.
  const res = await request.get(`${API}/images/ids?tags=any%3Asolo`);
  const n: number = (await res.json()).ids.length;
  expect(n).toBeGreaterThanOrEqual(7);

  await page.goto("/tags");
  await page.getByRole("button", { name: `solo ${n} images` }).click();
  await expect(page).toHaveURL(/[?&]tag=solo(&|$)/);

  const panel = page.getByRole("complementary", { name: "Tag solo" });
  await expect(panel.getByText(`${n} images`, { exact: false }).first()).toBeVisible();
  await expect(panel.getByRole("heading", { name: `Images · ${n}` })).toBeVisible();

  await panel.getByRole("link", { name: "Open in gallery" }).click();
  await expect(page).toHaveURL(/\/\?tags=any%3Asolo/);
  await expect(page.locator("[data-tile-index]")).toHaveCount(n);
});

test("closing the panel leaves the tag list", async ({ page }) => {
  await page.goto("/tags?tag=solo");
  const panel = page.getByRole("complementary", { name: "Tag solo" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close tag details" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]tag=/);
});
