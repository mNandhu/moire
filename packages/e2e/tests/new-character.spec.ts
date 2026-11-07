import { expect, test } from "@playwright/test";
import { API } from "./helpers";

test("New character: identity tags complete from the library's tags", async ({ page }) => {
  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });

  const add = dialog.getByLabel("Add identity tag");
  await add.fill("sol");
  const option = dialog.getByRole("option").filter({ hasText: "solo" }).first();
  await expect(option).toBeVisible();
  await option.getByRole("button").click();

  await expect(dialog.getByRole("button", { name: "Remove solo" })).toBeVisible();
  await expect(add).toHaveValue("");
  // Taken now: not offered again.
  await add.fill("sol");
  await expect(dialog.getByRole("option").filter({ hasText: /^solo/ })).toHaveCount(0);

  await add.fill("");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("Tag suggestions: the arrows keep the highlighted row in view", async ({ page }) => {
  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });

  const add = dialog.getByLabel("Add identity tag");
  await add.fill("a");
  const options = dialog.getByRole("option");
  await expect(options.first()).toBeVisible();
  // More rows than the list shows at once, so the last is below the fold.
  const count = await options.count();
  expect(count).toBeGreaterThan(10);
  for (let i = 1; i < count; i++) await add.press("ArrowDown");
  const selected = dialog.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  await expect(selected).toBeInViewport();
  await expect(options.first()).not.toBeInViewport();

  await add.fill("");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("New character: a picture link to a private address is refused", async ({ page }) => {
  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });

  const link = dialog.getByLabel("Picture link");
  await link.fill("http://127.0.0.1:7671/view?filename=x.png");
  await link.press("Enter");
  await expect(page.getByText("Couldn't tag the picture: Couldn't fetch a picture from that link")).toBeVisible();
  // Still open, the link kept to fix; Escape clears it, not the dialog.
  await expect(link).toHaveValue("http://127.0.0.1:7671/view?filename=x.png");
  await link.press("Escape");
  await expect(link).toHaveValue("");
  await expect(dialog).toBeVisible();
});

test("New character: a link pasted in the Tag field is taken as a picture", async ({ page }) => {
  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });

  const tagField = dialog.getByLabel("Tag", { exact: true });
  await tagField.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "http://10.0.0.1/a.png");
  // Sent to the tagger (and refused: a private address), not typed in.
  await expect(page.getByText("Couldn't fetch a picture from that link", { exact: false })).toBeVisible();
  await expect(tagField).toHaveValue("");
});

test("New character: a typed identity tag is kept without Enter", async ({ page }) => {
  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });

  await dialog.getByLabel("Add identity tag").fill("red hair");
  await dialog.getByLabel("Name", { exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove red_hair" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("Generate: a character's Edit tags dialog opens their page", async ({ page, request }) => {
  // A hand-made character (the fixture images carry the tag); 409 when made already.
  const made = await request.post(`${API}/tags/characters`, { data: { tag: "frieren", name: "Frieren" } });
  expect([200, 409]).toContain(made.status());
  await page.addInitScript((draft) => localStorage.setItem("moire.generate.draft", JSON.stringify(draft)), {
    characters: ["frieren"],
    prompt: "1girl",
  });
  await page.goto("/generate");
  await page.getByRole("button", { name: "Edit tags" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("link", { name: "Open character page" }).click();
  await expect(page).toHaveURL(/\/characters\/frieren$/);
  await expect(dialog).toHaveCount(0);
});
