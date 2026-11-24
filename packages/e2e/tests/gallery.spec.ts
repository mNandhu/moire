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

test("Ctrl+K finds an image by its file name and opens it", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const search = page.getByRole("combobox", { name: "Search", exact: true });
  // A space for the underscore, like tags.
  await search.fill("filler 042");
  const hit = page.getByRole("option", { name: /filler_042\.png/ });
  await expect(hit).toBeVisible();
  await expect(page.getByRole("option", { name: /filler_043\.png/ })).toHaveCount(0);
  await search.press("Enter");
  await expect(page).toHaveURL(/\/image\/[^?]*filler_042\.png/);
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

test("an address no page answers says so, with a way back", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "All Images" }).last().click();
  await expect(page).toHaveURL(/\/$/);
});

test("shuffle orders the gallery at random and Reshuffle deals a new order", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "Reshuffle" })).toHaveCount(0);

  await page.getByRole("radio", { name: "Shuffled" }).click();
  await expect(page).toHaveURL(/[?&]sort=shuffle(&|$)/);
  await expect(page.locator(tiles).first()).toBeVisible();
  // The first tiles' file paths (their alt text), in grid order.
  const firstIds = async () =>
    page.locator(tiles).evaluateAll((els) =>
      els
        .map((e) => [Number(e.getAttribute("data-tile-index")), e.querySelector("img[alt]")?.getAttribute("alt")] as const)
        .sort((a, b) => a[0] - b[0])
        .slice(0, 12)
        .map(([, alt]) => alt),
    );
  const before = await firstIds();

  const reshuffled = page.waitForResponse((r) => r.url().includes(`${API}/images/reshuffle`));
  const refetched = page.waitForRequest(
    (r) => new URL(r.url()).pathname === `${API}/images` && new URL(r.url()).searchParams.get("sort") === "shuffle",
  );
  // Shuffle, once on, deals again in place.
  await page.getByRole("radio", { name: "Reshuffle" }).click();
  expect((await reshuffled).ok()).toBe(true);
  await refetched;
  // Twelve tiles in the same order again is a one in billions chance.
  await expect.poll(firstIds).not.toEqual(before);
});

test("Random image opens a random image and steps through more of them", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(tiles).first()).toBeVisible();

  await page.getByRole("button", { name: "Random image" }).click();
  await expect(page).toHaveURL(/\/image\//);
  const first = page.url();
  // The view is up, holding its run of random picks, before a key goes in.
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.keyboard.press("ArrowRight");
  await expect(page).not.toHaveURL(first);
  await expect(page).toHaveURL(/\/image\//);

  // R from the gallery does the same.
  await page.keyboard.press("Escape");
  await expect(page).not.toHaveURL(/\/image\//);
  await page.keyboard.press("r");
  await expect(page).toHaveURL(/\/image\//);
});

test("the filter panel stays open while filters are picked, a Made range among them", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Show filters" }).click();
  const panel = page.getByRole("dialog", { name: "Filters" });

  // Picking an option leaves the panel open for the next filter.
  await panel.getByRole("button", { name: "Tag logic" }).click();
  await page.getByRole("option", { name: /Match any/ }).click();
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "Made filter" }).click();
  await page.getByRole("option", { name: /Custom range/ }).click();
  await expect(panel).toBeVisible();

  // From: today, by keyboard (the month opens on it).
  await panel.getByRole("button", { name: "Made from" }).click();
  await expect(page.getByRole("dialog", { name: "Made from" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]made_from=\d+/);
  await expect(panel.getByRole("button", { name: /^Made from: / })).toBeVisible();

  // To: today too, by mouse, through Today.
  await panel.getByRole("button", { name: "Made to" }).click();
  await page.getByRole("dialog", { name: "Made to" }).getByRole("button", { name: "Today" }).click();
  await expect(page).toHaveURL(/[?&]made_to=\d+/);

  await page.getByRole("button", { name: "Hide filters" }).click();
  await expect(page.getByRole("button", { name: /^Remove filter: Made [A-Z][a-z]{2} \d+/ })).toBeVisible();
});
