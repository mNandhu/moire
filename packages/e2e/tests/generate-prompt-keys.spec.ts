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
