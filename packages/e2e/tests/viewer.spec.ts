import { expect, test, type Locator } from "@playwright/test";
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
  // Newest first: furina_41, furina_63, shinobu_23.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("furina_63.png", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.url()).toContain(here);
  await expect(page.getByText("furina_41.png", { exact: true })).toBeVisible();
});

test("arrow keys pressed back to back each take a step", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "furina/furina_41.png");
  const { _id: twoOn } = await imageByPath(request, "shinobu/shinobu_23.png");
  await page.goto(viewerUrl(_id));
  await expect(page.getByText("furina_41.png", { exact: true })).toBeVisible();

  // Both keys in one task, so the view cannot re-render between them: the
  // second steps from where the first went.
  const keys = (...names: string[]) =>
    page.evaluate((ks) => {
      for (const key of ks) document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    }, names);
  await keys("ArrowRight", "ArrowLeft");
  await expect(page.getByText("furina_41.png", { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toContain(viewerUrl(_id));
  await keys("ArrowRight", "ArrowRight");
  await expect(page.getByText("shinobu_23.png", { exact: true })).toBeVisible();
  await expect.poll(() => page.url()).toContain(viewerUrl(twoOn));
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  // The sheet slides between stops: measure it once it has come to rest.
  const settledBox = async (loc: Locator) => {
    let last = "";
    await expect
      .poll(async () => {
        const box = await loc.boundingBox();
        const now = JSON.stringify(box);
        const still = box !== null && now === last;
        last = now;
        return still;
      })
      .toBe(true);
    return (await loc.boundingBox())!;
  };

  test("the details sheet drags up to read and down to close", async ({ page, request }) => {
    const { _id } = await imageByPath(request, "furina/furina_41.png");
    await page.goto(viewerUrl(_id));
    // A phone opens on the image; the sheet comes up to its peek.
    await page.getByRole("button", { name: "Show details" }).click();
    const details = page.getByRole("region", { name: "Image details" });
    await expect(details.getByText("furina_41.png", { exact: true })).toBeInViewport();

    // Dragging its grip up opens it fully.
    const grip = page.getByRole("button", { name: "Raise details" });
    const box = await settledBox(grip);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 4 });
    await page.mouse.move(x, 40, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByRole("button", { name: "Lower details" })).toBeVisible();

    // A tap on the grip lowers it back to the peek: a drag's click doesn't.
    await page.getByRole("button", { name: "Lower details" }).click();
    await expect(page.getByRole("button", { name: "Raise details" })).toBeVisible();

    // Dragged off the bottom, it closes and the stage offers it back.
    const peek = await settledBox(page.getByRole("button", { name: "Raise details" }));
    await page.mouse.move(x, peek.y + peek.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, peek.y + 40, { steps: 4 });
    await page.mouse.move(x, 840, { steps: 8 });
    await page.mouse.up();
    await page.getByRole("button", { name: "Show details" }).click();
    await expect(page.getByRole("button", { name: "Raise details" })).toBeVisible();
  });
});
