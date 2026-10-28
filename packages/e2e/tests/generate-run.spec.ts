import { expect, test } from "@playwright/test";
import { API, sandbox } from "./helpers";

// A real run, end to end, on the fake ComfyUI: it saves small PNGs into the
// sandbox folder set as Generate's output folder, and Moiré indexes them.
test("a Generate run lands its images in the output library", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { comfy_out } = sandbox();

  await page.goto("/settings?section=comfyui");
  // The fake runs on this machine and saves into comfy_out: that folder is
  // both the output library and ComfyUI's own output root, so finished
  // images are linked where they are.
  for (const name of ["Output folder", "ComfyUI saves to"]) {
    const box = page.getByRole("textbox", { name });
    await box.fill(comfy_out);
    await box.locator("xpath=following-sibling::button[1]").click();
    await expect(box.locator("xpath=following-sibling::button[1]")).toBeDisabled();
  }
  await expect
    .poll(async () => (await (await request.get(`${API}/generate/comfyui`)).json()).output_root)
    .toBe(comfy_out);

  await page.goto("/generate");
  await page.getByLabel("Prompt", { exact: true }).fill("1girl, smile, garden");
  await page.getByRole("spinbutton", { name: "Images", exact: true }).fill("2");
  await page.getByRole("button", { name: "Test run" }).click();
  const run = page.getByRole("button", { name: "Queue 2 images" });
  await expect(run).toBeEnabled({ timeout: 30_000 });
  await run.click();

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
});
