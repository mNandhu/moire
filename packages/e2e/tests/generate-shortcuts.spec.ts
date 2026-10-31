import { expect, test } from "@playwright/test";

// docs/e2e-scenarios.md, "Generate: keys and Clear". Runs after
// generate-run.spec.ts, which sets the output folder and passes the test run.

test("Ctrl+Z brings back a tag taken out on the board, Ctrl+Shift+Z takes it out again", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("1girl, red hair, blue eyes");
  const board = page.getByLabel("Prompt board");
  await board.getByRole("button", { name: "Remove red hair" }).click();
  await expect(prompt).not.toHaveValue(/red hair/);

  // Off the text field: there the field keeps its own undo.
  await page.getByRole("heading", { name: "Generate" }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(prompt).toHaveValue(/red hair/);
  await expect(board.getByRole("button", { name: "Remove red hair" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(prompt).not.toHaveValue(/red hair/);
});

test("Ctrl+Enter in the prompt queues the batch", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("1girl, smile, garden");
  // The workflow's test run (the run spec may not have made it yet).
  const test_ = page.getByRole("button", { name: "Test run" });
  if (await test_.isVisible()) await test_.click();
  await expect(page.getByRole("button", { name: /^Queue/ })).toBeEnabled({ timeout: 30_000 });

  const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
  await prompt.focus();
  await page.keyboard.press("ControlOrMeta+Enter");
  expect((await queued).ok()).toBe(true);
  // The key queued; it wrote nothing into the prompt.
  await expect(prompt).toHaveValue("1girl, smile, garden");
});

test("Clear empties the output column, and a new batch shows again", async ({ page }) => {
  await page.goto("/generate");
  const output = page.getByRole("complementary", { name: "Output" });
  const clear = output.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeVisible({ timeout: 30_000 });
  // Wait out a batch still running: it stays until it's done.
  await expect(output.getByText(/ \/ \d+$/)).toHaveCount(0, { timeout: 60_000 });
  await clear.click();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(0);
  await page.reload();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(0);

  await page.getByLabel("Prompt", { exact: true }).fill("1girl, smile, garden");
  await page.getByRole("button", { name: /^Queue/ }).click();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(1, { timeout: 30_000 });
});
