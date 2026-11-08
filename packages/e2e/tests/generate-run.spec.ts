import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, COMFY_OUT, viewerUrl } from "./helpers";

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

type BatchDoc = { requests: { outputs: { image_id: string; in_library: boolean }[] }[] };

/** A batch's images, once every one is in the library. */
async function batchImages(request: APIRequestContext, id: number, count: number): Promise<string[]> {
  let ids: string[] = [];
  await expect
    .poll(
      async () => {
        const b: BatchDoc = await (await request.get(`${API}/generate/batches/${id}`)).json();
        const outs = b.requests.flatMap((q) => q.outputs);
        ids = outs.map((o) => o.image_id);
        return outs.filter((o) => o.in_library).length;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(count);
  return ids;
}

// Runs after the test above, which set the output folder. The report: a
// second Queue press of the same prompt, queued while the first still ran,
// showed in the first one's "This batch" strip but not on its batch page.
test("a second Queue press of the same prompt is its own batch", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto("/generate");
  await page.getByLabel("Prompt", { exact: true }).fill("1girl, batch strip, park");
  const images = page.getByRole("spinbutton", { name: "Images", exact: true });
  const queue = async (n: number): Promise<number> => {
    await images.fill(String(n));
    const run = page.getByRole("button", { name: `Queue ${n} image${n === 1 ? "" : "s"}` });
    await expect(run).toBeEnabled({ timeout: 30_000 });
    const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
    await run.click();
    return ((await (await queued).json()) as { _id: number })._id;
  };
  const first = await queue(2);
  const second = await queue(1);
  const [a] = await batchImages(request, first, 2);
  const [c] = await batchImages(request, second, 1);

  // The first batch's strip holds its own two images, and names its page.
  await page.goto(viewerUrl(a));
  await page.getByRole("tab", { name: /^Generation/ }).click();
  const strip = page.getByRole("group", { name: "This batch" });
  await expect(strip.getByRole("link")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "This batch", exact: true })).toHaveAttribute("href", `/generations/${first}`);

  // The second is alone in its batch: no strip, though the prompt is the same.
  const read = page.waitForResponse((r) => new URL(r.url()).searchParams.get("gen_batch") === String(second));
  await page.goto(viewerUrl(c));
  await page.getByRole("tab", { name: /^Generation/ }).click();
  await read;
  await expect(strip).toHaveCount(0);

  // The gallery still stacks every run of the prompt. Its back control says
  // where it goes, and goes there.
  await page.goto("/?group=1");
  await page.locator("[data-tile-index]").filter({ has: page.getByRole("img", { name: "3 variations in this batch" }) }).click();
  await expect(page.getByRole("heading", { name: "Batch Images" })).toBeVisible();
  await expect(page.locator("[data-tile-index]")).toHaveCount(3);
  // Grouping is still on inside the stack, and the toggle says so.
  await expect(page.getByRole("button", { name: "Group batches" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Back to All Images" }).click();
  await expect(page.getByRole("heading", { name: "All Images" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get("group_id")).toBeNull();
  expect(new URL(page.url()).searchParams.get("group")).toBe("1");
});
