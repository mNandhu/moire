import { expect, test } from "@playwright/test";

test("Ctrl+Up and Ctrl+Down weigh the tag under the caret", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("1girl, red hair, smile");
  // The caret inside "red hair".
  await prompt.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(10, 10));

  await prompt.press("ControlOrMeta+ArrowUp");
  await expect(prompt).toHaveValue("1girl, (red hair:1.05), smile");
  await prompt.press("ControlOrMeta+ArrowUp");
  await expect(prompt).toHaveValue("1girl, (red hair:1.1), smile");

  // Back to 1 drops the brackets; below 1 brings them back.
  await prompt.press("ControlOrMeta+ArrowDown");
  await prompt.press("ControlOrMeta+ArrowDown");
  await expect(prompt).toHaveValue("1girl, red hair, smile");
  await prompt.press("ControlOrMeta+ArrowDown");
  await expect(prompt).toHaveValue("1girl, (red hair:0.95), smile");
});

test("with the caret on a group's own weight, the group is weighed", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("(masterpiece, best quality,:1.1), smile");
  // The caret in the group's ":1.1".
  await prompt.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(29, 29));

  await prompt.press("ControlOrMeta+ArrowUp");
  await expect(prompt).toHaveValue("(masterpiece, best quality,:1.15), smile");
  await prompt.press("ControlOrMeta+ArrowDown");
  await prompt.press("ControlOrMeta+ArrowDown");
  await expect(prompt).toHaveValue("(masterpiece, best quality,:1.05), smile");
});

test("Ctrl+Up weighs in a preset's text too", async ({ page }) => {
  await page.goto("/generate");
  await page.getByLabel("Prefix preset").click();
  await page.getByRole("option", { name: "New preset" }).click();
  const text = page.getByLabel("Preset text");
  await text.fill("(masterpiece, best quality:1.1), smile");
  await text.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(36, 36));

  await text.press("ControlOrMeta+ArrowUp");
  await expect(text).toHaveValue("(masterpiece, best quality:1.1), (smile:1.05)");
});
