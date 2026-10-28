import { expect, test } from "@playwright/test";
import { imageById, imageByPath, viewerUrl } from "./helpers";

test("the Tags tab shows prompt weights", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "weighted/weighted.png");
  await page.goto(viewerUrl(_id));
  await page.getByRole("tab", { name: /^Tags/ }).click();
  const panel = page.getByRole("tabpanel");
  // (red_scarf:1.3) and [blurry] (1 / 1.1); unweighted tags carry no number.
  await expect(panel.getByRole("link", { name: "red scarf1.3" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "blurry0.91" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "smile", exact: true })).toBeVisible();
});

test("a ComfyUI prompt escaped twice reads as ComfyUI reads it", async ({ page, request }) => {
  // furina_63 keeps the prompt as it was queued: `furina \\(genshin impact\\)`
  // and an escaped `\(shallow depth of field:1.4\)`. ComfyUI reads both as
  // text, so one character tag and no weight.
  const { _id } = await imageByPath(request, "furina/furina_63.png");
  await page.goto(viewerUrl(_id));
  await page.getByRole("tab", { name: /^Tags/ }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("link", { name: "furina (genshin impact)", exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: /^shallow depth of field1\.4$/ })).toHaveCount(0);
  // Its twin furina_41 has the prompt written right: the weight shows.
  const twin = await imageByPath(request, "furina/furina_41.png");
  await page.goto(viewerUrl(twin._id));
  await page.getByRole("tab", { name: /^Tags/ }).click();
  await expect(panel.getByRole("link", { name: "shallow depth of field1.4" })).toBeVisible();
});

test("tags added in the viewer are saved as manual tags", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "weighted/weighted.png");
  await page.goto(viewerUrl(_id));
  await page.getByRole("tab", { name: /^Tags/ }).click();
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Add tags" }).click();
  const input = panel.getByRole("textbox", { name: "Add tags" });
  await input.fill("e2e manual, cozy");
  await input.press("Enter");
  await expect(panel.getByRole("link", { name: "e2e manual" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "cozy", exact: true })).toBeVisible();

  // Stored canonical (underscores), as manual tags, next to the prompt ones.
  const { tags } = await imageById(request, _id);
  expect(tags).toEqual(expect.arrayContaining(["manual:e2e_manual", "manual:cozy", "prompt:smile"]));

  await page.reload();
  await page.getByRole("tab", { name: /^Tags/ }).click();
  await expect(page.getByRole("tabpanel").getByRole("link", { name: "e2e manual" })).toBeVisible();
});

test("a score set in the viewer sticks", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "frieren/frieren_31.png");
  await page.goto(viewerUrl(_id));
  const score = page.getByRole("radiogroup", { name: "Score" });
  await score.getByRole("radio", { name: "Set score 4" }).click();
  await expect(score.getByRole("radio", { name: "Set score 4" })).toBeChecked();

  await page.reload();
  await expect(page.getByRole("radiogroup", { name: "Score" }).getByRole("radio", { name: "Set score 4" })).toBeChecked();
  await expect.poll(async () => (await imageById(request, _id)).score).toBe(4);
});

test("arrow keys step through the feed", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "furina/furina_41.png");
  await page.goto(viewerUrl(_id));
  await expect(page.getByText("furina_41.png", { exact: true })).toBeVisible();

  const here = viewerUrl(_id);
  // Newest first, so the next image is the older furina_63. Wait for it to
  // show before going back: a key pressed before the view has moved on
  // steps from the old place.
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.url()).not.toContain(here);
  await expect(page.getByText("furina_63.png", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.url()).toContain(here);
  await expect(page.getByText("furina_41.png", { exact: true })).toBeVisible();
});
