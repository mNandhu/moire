import { expect, test } from "@playwright/test";
import { API, COMFY_OUT } from "./helpers";

// A real run, end to end, on the fake ComfyUI: it saves small PNGs into the
// sandbox folder set as Generate's output folder, and Moiré indexes them.
test("a Generate run lands its images in the output library", async ({ page, request }) => {
  test.setTimeout(120_000);
  const comfy_out = COMFY_OUT;

  await page.goto("/settings?section=comfyui");
  // The fake runs on this machine and saves into comfy_out: that folder is
  // both the output library and ComfyUI's own output root, so finished
  // images are linked where they are.
  for (const name of ["Output folder", "ComfyUI saves to"]) {
    const box = page.getByRole("textbox", { name });
    const save = box.locator("xpath=following-sibling::button[1]");
    await box.fill(comfy_out);
    // Enabled only when the value changed.
    if (await save.isEnabled()) await save.click();
    await expect(save).toBeDisabled();
  }
  await expect
    .poll(async () => (await (await request.get(`${API}/generate/comfyui`)).json()).output_root)
    .toBe(comfy_out);

  await page.goto("/generate");
  await page.getByLabel("Prompt", { exact: true }).fill("1girl, smile, garden");
  await page.getByRole("spinbutton", { name: "Images", exact: true }).fill("2");
  await page.getByRole("button", { name: "Fewer Images" }).click();
  await page.getByRole("button", { name: "More Images" }).click();
  await expect(page.getByRole("spinbutton", { name: "Images", exact: true })).toHaveValue("2");

  // The batch name: renamed on Enter, Escape keeps it, the auto name comes back.
  await page.getByRole("button", { name: "Rename batch" }).click();
  await page.getByRole("textbox", { name: "Batch name" }).fill("Garden test");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Garden test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename batch" }).click();
  await page.getByRole("textbox", { name: "Batch name" }).fill("Dropped");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Garden test", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rename batch" }).click();
  await page.getByRole("button", { name: "Use auto name" }).click();
  await expect(page.getByText("Garden test", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Test run" }).click();
  const run = page.getByRole("button", { name: "Queue 2 images" });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
  await run.click();
  const batch: { _id: number } = await (await queued).json();

  const output = page.getByRole("complementary", { name: "Output" });
  await expect(output).not.toContainText("Nothing in queue");
  await expect
    .poll(
      async () => {
        const libs = await (await request.get(`${API}/libraries`)).json();
        const out = libs.find((l: { path: string }) => l.path === comfy_out);
        return out?.indexed_count ?? 0;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBeGreaterThanOrEqual(2);

  // The batch page renames on Enter and keeps the name on Escape.
  await page.goto(`/generations/${batch._id}`);
  await page.getByRole("button", { name: "Rename batch" }).click();
  await page.getByRole("textbox", { name: "Batch name" }).fill("Garden, renamed");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /Garden, renamed/ })).toBeVisible();
  await page.getByRole("button", { name: "Rename batch" }).click();
  await page.getByRole("textbox", { name: "Batch name" }).fill("Dropped");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("heading", { name: /Garden, renamed/ })).toBeVisible();
});
