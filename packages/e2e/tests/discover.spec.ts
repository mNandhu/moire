import { expect, test } from "@playwright/test";
import { API, imageByPath } from "./helpers";

test("Discover shows random picks that open, step and deal again", async ({ page, request }) => {
  // Four top rated images: a shelf needs that many to show.
  for (const part of ["filler_007", "filler_008", "filler_009", "filler_010"]) {
    const { _id } = await imageByPath(request, part);
    const scored = await request.post(`${API}/images/${encodeURIComponent(_id)}/score`, { data: { score: 5 } });
    expect(scored.ok()).toBe(true);
  }

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

  // Shuffle deals every shelf again: the strip changes (the same twelve
  // again is a near miss).
  await page.getByRole("button", { name: "Shuffle", exact: true }).click();
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

test("Discover's not seen in a while puts favorites first and drops an image once it is opened", async ({ page, request }) => {
  // Two favorites no other spec opens, so they start out never viewed and
  // lead the shelf.
  const fav = await imageByPath(request, "filler_031");
  for (const part of ["filler_031", "filler_032"]) {
    const { _id } = await imageByPath(request, part);
    const scored = await request.post(`${API}/images/${encodeURIComponent(_id)}/score`, { data: { score: 5 } });
    expect(scored.ok()).toBe(true);
  }
  const unseenFavoriteIds = async () => {
    const res = await request.get(`${API}/images?min_score=4&unviewed_days=30&limit=200`);
    return ((await res.json()) as { _id: string }[]).map((r) => r._id);
  };

  await page.goto("/discover");
  const unseen = page.getByRole("region", { name: "Not seen in a while" });
  const tile = unseen.getByRole("link", { name: /filler_031\.png/ });
  await expect(tile).toBeVisible();

  // Opened and looked at: seen now.
  await tile.click();
  await expect(page).toHaveURL(/\/image\//);
  await expect.poll(unseenFavoriteIds, { timeout: 10_000 }).not.toContain(fav._id);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Shuffle", exact: true }).click();
  // The new pick loaded (the other favorite), and the opened one is not in it.
  await expect(unseen.getByRole("link", { name: /filler_032\.png/ })).toBeVisible();
  await expect(tile).toHaveCount(0);

  await unseen.getByRole("link", { name: "View all" }).click();
  await expect(page).toHaveURL(/[?&]unviewed_days=30/);
  await expect(page).toHaveURL(/[?&]sort=top/);
  await expect(page.getByRole("button", { name: "Remove filter: Not opened in 30 days" })).toBeVisible();
});

test("Discover's banner features a character and opens their page", async ({ page }) => {
  await page.goto("/discover");
  const hero = page.getByRole("region", { name: "Featured character" });
  const name = hero.getByRole("heading");
  await expect(name).toBeVisible();
  await hero.getByRole("link", { name: "Open character" }).click();
  await expect(page).toHaveURL(/\/characters\//);
});

test("an image quarantined from Discover leaves its shelf", async ({ page, request }) => {
  await page.goto("/discover");
  const unscored = page.getByRole("region", { name: "Unscored" });
  const first = unscored.getByRole("link", { name: /\.png$/ }).first();
  await expect(first).toBeVisible();
  const label = String(await first.getAttribute("aria-label"));
  await first.click();
  await expect(page).toHaveURL(/\/image\//);
  const id = decodeURIComponent(page.url().split("/image/")[1].split("?")[0]);
  try {
    await page.getByRole("button", { name: "Quarantine", exact: true }).click();
    await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/discover$/);
    await expect(unscored.getByRole("link", { name: label, exact: true })).toHaveCount(0);
  } finally {
    await request.post(`${API}/images/${encodeURIComponent(id)}/quarantine`, { data: { quarantined: false } });
  }
});
