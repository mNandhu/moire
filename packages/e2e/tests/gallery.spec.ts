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

test("Edit tags adds and removes a manual tag on a whole Select all", async ({ page, request }) => {
  const n = sandbox().images;
  const edit = async (box: string, verb: RegExp) => {
    await page.getByRole("button", { name: `${n} selected` }).click();
    await page.getByRole("menuitem", { name: "Edit tags" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Edit tags on ${n} images`);
    const input = dialog.getByPlaceholder(box);
    await input.fill("e2e bulk");
    await input.press("Enter");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(verb)).toBeVisible();
    await expect(dialog).toBeHidden();
  };
  const tagged = async () => {
    const r = await request.get(`${API}/images/ids`, { params: { tags: "manual:e2e_bulk" } });
    return (await r.json()).ids.length;
  };

  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();
  await page.getByRole("button", { name: "Select images" }).click();
  await page.getByRole("button", { name: "Select all" }).click();
  await expect(page.getByRole("button", { name: `${n} selected` })).toBeVisible();

  try {
    await edit("Type a tag, Enter to add", new RegExp(`Updated tags on ${n} of ${n} images`));
    expect(await tagged()).toBe(n);

    // Taken off again in the UI, so the sandbox library is as the other specs expect it.
    await edit("Tags to take off these images", new RegExp(`Updated tags on ${n} of ${n} images`));
    expect(await tagged()).toBe(0);
  } finally {
    // And through the API if a step above failed with the tag still on.
    const ids = (await (await request.get(`${API}/images/ids`, { params: { tags: "manual:e2e_bulk" } })).json()).ids;
    if (ids.length) await request.post(`${API}/tags/bulk`, { data: { image_ids: ids, remove: ["e2e_bulk"] } });
  }
});
