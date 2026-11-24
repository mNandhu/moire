import { expect, test } from "@playwright/test";
import { API, imageByPath } from "./helpers";

test("Discover shows random picks that open, step and deal again", async ({ page, request }) => {
  // One top rated image, so that section has something to show.
  const star = await imageByPath(request, "filler_007");
  const scored = await request.post(`${API}/images/${encodeURIComponent(star._id)}/score`, { data: { score: 5 } });
  expect(scored.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("link", { name: "Discover" }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const top = page.getByRole("region", { name: "Top rated" });
  await expect(top.getByRole("link", { name: /filler_007\.png/ })).toBeVisible();

  const unscored = page.getByRole("region", { name: "Unscored" });
  const strip = unscored.getByRole("link", { name: /\.png$/ });
  await expect(strip.first()).toBeVisible();
  const names = () => strip.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const before = await names();

  // A new pick: the strip changes (the same twelve again is a near miss).
  await unscored.getByRole("button", { name: "Pick again: Unscored" }).click();
  await expect.poll(names).not.toEqual(before);

  // Opening one steps through the strip, not the gallery feed.
  const picks = await names();
  await strip.first().click();
  await expect(page).toHaveURL(/\/image\//);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => decodeURIComponent(page.url())).toContain(String(picks[1]).split("/").pop());
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/discover$/);

  // View all: the gallery, shuffled, with the same filter.
  await unscored.getByRole("link", { name: "View all" }).click();
  await expect(page).toHaveURL(/[?&]unscored=1/);
  await expect(page).toHaveURL(/[?&]sort=shuffle/);
  await expect(page.getByRole("button", { name: "Remove filter: Unscored" })).toBeVisible();
});

test("Discover's rare tags lead to their gallery", async ({ page }) => {
  await page.goto("/discover");
  const rare = page.getByRole("region", { name: "Rare tags" });
  const tag = rare.locator("a[href^='/?']").first();
  await expect(tag).toBeVisible();
  await tag.click();
  await expect(page).toHaveURL(/[?&]tags=/);
  await expect(page.locator("[data-tile-index]").first()).toBeVisible();
});

test("Discover's forgotten favorites drop an image once it is opened", async ({ page, request }) => {
  // Two favorites no other spec opens, so they start out never viewed; the
  // second keeps the section up once the first is opened.
  const fav = await imageByPath(request, "filler_031");
  for (const part of ["filler_031", "filler_032"]) {
    const { _id } = await imageByPath(request, part);
    const scored = await request.post(`${API}/images/${encodeURIComponent(_id)}/score`, { data: { score: 5 } });
    expect(scored.ok()).toBe(true);
  }
  const forgottenIds = async () => {
    const res = await request.get(`${API}/images?min_score=4&unviewed_days=30&limit=200`);
    return ((await res.json()) as { _id: string }[]).map((r) => r._id);
  };

  await page.goto("/discover");
  const forgotten = page.getByRole("region", { name: "Forgotten favorites" });
  const tile = forgotten.getByRole("link", { name: /filler_031\.png/ });
  await expect(tile).toBeVisible();

  // Opened and looked at: no longer forgotten.
  await tile.click();
  await expect(page).toHaveURL(/\/image\//);
  await expect.poll(forgottenIds, { timeout: 10_000 }).not.toContain(fav._id);
  await page.keyboard.press("Escape");
  await forgotten.getByRole("button", { name: "Pick again: Forgotten favorites" }).click();
  // The new pick loaded (the other favorite), and the opened one is not in it.
  await expect(forgotten.getByRole("link", { name: /filler_032\.png/ })).toBeVisible();
  await expect(tile).toHaveCount(0);

  await forgotten.getByRole("link", { name: "View all" }).click();
  await expect(page).toHaveURL(/[?&]unviewed_days=30/);
  await expect(page.getByRole("button", { name: "Remove filter: Not opened in 30 days" })).toBeVisible();
});
