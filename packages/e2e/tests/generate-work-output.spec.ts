import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, COMFY_PORT } from "./helpers";

// docs/e2e-scenarios.md, "Generate: output column and LoRA switches". Runs
// after generate-run.spec.ts (named to sort after it), which sets the output
// folder and passes the test run.

type Batch = { _id: number; requests: { state: string; outputs: { image_id: string; in_library: boolean; quarantined: boolean }[] }[] };

const COMFY = `http://127.0.0.1:${COMFY_PORT}`;

/** Until no batch is still running or paused. */
async function settled(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const list: { state: string }[] = await (await request.get(`${API}/generate/batches?limit=20`)).json();
      return list.filter((b) => b.state === "running" || b.state === "paused").length;
    }, { timeout: 60_000 })
    .toBe(0);
}

/** Queues `n` images from the composer as it stands; the batch's id. */
async function queue(page: Page, n: number, prompt = "1girl, smile, garden"): Promise<number> {
  await page.getByLabel("Prompt", { exact: true }).fill(prompt);
  await page.getByRole("spinbutton", { name: "Images", exact: true }).fill(String(n));
  await expect(page.getByRole("button", { name: /^Queue/ })).toBeEnabled({ timeout: 30_000 });
  const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: /^Queue/ }).click();
  return ((await (await queued).json()) as { _id: number })._id;
}

const getBatch = async (request: APIRequestContext, id: number): Promise<Batch> =>
  (await request.get(`${API}/generate/batches/${id}`)).json();

async function emptyColumn(page: Page) {
  const output = page.getByRole("complementary", { name: "Output" });
  const clear = output.getByRole("button", { name: "Clear", exact: true });
  // Earlier specs leave batches in the column; wait for them to load.
  await clear.waitFor({ timeout: 30_000 }).catch(() => {});
  if (await clear.isVisible()) await clear.click();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(0);
  return output;
}

test("an image made while the tab is hidden is there on coming back", async ({ page, request }) => {
  await settled(request);
  await page.goto("/generate");
  const output = await emptyColumn(page);
  const id = await queue(page, 1);
  // Another window over Moiré: the page is hidden while the batch runs.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => (await getBatch(request, id)).requests.flatMap((q) => q.outputs).filter((o) => o.in_library).length, {
      timeout: 60_000,
    })
    .toBe(1);
  // Still hidden: the column has polled on and shows it.
  await expect(output.locator('a[href^="/image/"]')).toHaveCount(1, { timeout: 15_000 });
});

test("Clear rejected takes rejected images out of the column only", async ({ page, request }) => {
  await settled(request);
  await page.goto("/generate");
  const output = await emptyColumn(page);
  const id = await queue(page, 2);
  let ids: string[] = [];
  await expect
    .poll(async () => {
      ids = (await getBatch(request, id)).requests.flatMap((q) => q.outputs).filter((o) => o.in_library).map((o) => o.image_id);
      return ids.length;
    }, { timeout: 60_000 })
    .toBe(2);
  const strip = output.getByRole("tablist", { name: "Images in this batch" });
  await expect(strip.getByRole("tab")).toHaveCount(2, { timeout: 15_000 });
  await expect(output.getByRole("button", { name: "Clear rejected" })).toHaveCount(0);

  // Reject the one on show (X on the tile), as the column does.
  const tile = output.locator('[aria-keyshortcuts="K X 1 2 3 4 5"]');
  await tile.focus();
  await tile.press("x");
  await output.getByRole("button", { name: "Clear rejected" }).click({ timeout: 15_000 });
  // One image left: no strip to pick from.
  await expect(strip).toHaveCount(0);
  await expect(output.getByRole("button", { name: "Clear rejected" })).toHaveCount(0);
  // Kept everywhere else: the batch still has both, one of them rejected.
  const left = (await getBatch(request, id)).requests.flatMap((q) => q.outputs);
  expect(left).toHaveLength(2);
  const gone = left.find((o) => o.quarantined)!.image_id;
  await page.reload();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(1);
  await expect(output.getByRole("tablist", { name: "Images in this batch" })).toHaveCount(0);

  // Restored, it shows again.
  await request.post(`${API}/images/${encodeURIComponent(gone)}/quarantine`, { data: { quarantined: false } });
  await page.reload();
  await expect(output.getByRole("tablist", { name: "Images in this batch" }).getByRole("tab")).toHaveCount(2, { timeout: 15_000 });
});

test("Clear failed removes failed requests from their batch", async ({ page, request }) => {
  await settled(request);
  await page.goto("/generate");
  const output = await emptyColumn(page);
  await request.post(`${COMFY}/fake/fail?count=1`);
  const id = await queue(page, 1);
  await expect(output.getByText("fake failure")).toBeVisible({ timeout: 60_000 });

  await output.getByRole("button", { name: "Clear failed" }).click();
  // Nothing else in it: the batch is gone.
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(0);
  expect((await request.get(`${API}/generate/batches/${id}`)).status()).toBe(404);
  await request.post(`${COMFY}/fake/fail?count=0`);
});

test("a switched-off LoRA stays in the composer but isn't sent", async ({ page, request }) => {
  await settled(request);
  await page.goto("/generate");
  await page.getByRole("button", { name: "Add LoRA" }).click();
  await page.getByRole("option", { name: /flat_color_xl/ }).click();
  const use = page.getByRole("checkbox", { name: "Use flat_color_xl" });
  await expect(use).toBeChecked();
  // The box is drawn over its input: toggle it from the keyboard.
  await use.focus();
  await use.press("Space");
  await expect(use).not.toBeChecked();

  const sent = page.waitForRequest((r) => r.method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
  await queue(page, 1);
  expect((await sent).postDataJSON().loras).toEqual([]);
  // Still there after a reload, still off.
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Use flat_color_xl" })).not.toBeChecked();
  const remove = page.getByRole("button", { name: "Remove flat_color_xl" });
  await remove.focus();
  await remove.press("Enter");
  await expect(remove).toHaveCount(0);
  await settled(request);
});

test("typing a Danbooru alias suggests its tag", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("");
  // `smiling` is Danbooru's alias of `smile`, a tag the library has.
  await prompt.pressSequentially("smiling");
  await expect(page.getByRole("listbox").getByRole("option").first()).toContainText("smile");
  await prompt.press("Tab");
  await expect(prompt).toHaveValue(/^smile/);
});
