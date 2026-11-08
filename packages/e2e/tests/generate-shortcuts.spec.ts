import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, COMFY_PORT, FAKE_COMFY_RUN } from "./helpers";

const COMFY = `http://127.0.0.1:${COMFY_PORT}`;

// docs/e2e-scenarios.md, "Generate: keys and Clear". Runs after
// generate-run.spec.ts, which sets the output folder and passes the test run.

/** Until no batch is still running or paused (one queued by an earlier
 * test): Clear keeps those. */
async function settled(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const list: { state: string }[] = await (await request.get(`${API}/generate/batches?limit=20`)).json();
      return list.filter((b) => b.state === "running" || b.state === "paused").length;
    }, { timeout: 60_000 })
    .toBe(0);
}

test("Ctrl+Z brings back a tag taken out on the board, Ctrl+Shift+Z takes it out again", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill("1girl, red hair, blue eyes");
  const board = page.getByLabel("Prompt board");
  await board.getByRole("button", { name: "Remove red hair" }).click();
  await expect(prompt).not.toHaveValue(/red hair/);

  // Focus is on the board now, not the text field (that keeps its own undo).
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

test("a batch still in the queue when Clear is pressed stays once done", async ({ page, request }) => {
  // Nothing else running: this batch's progress is the only one on show.
  await settled(request);
  await page.goto("/generate");
  const output = page.getByRole("complementary", { name: "Output" });
  const panels = output.getByRole("link", { name: "Batch page" });
  await page.getByLabel("Prompt", { exact: true }).fill("1girl, smile, garden");
  await page.getByRole("spinbutton", { name: "Images", exact: true }).fill("2");
  await expect(page.getByRole("button", { name: /^Queue/ })).toBeEnabled({ timeout: 30_000 });
  // Each image slow enough that the batch is still making them when Clear is pressed.
  await request.post(`${COMFY}/fake/run?seconds=3`);
  try {
    const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
    await page.getByRole("button", { name: /^Queue/ }).click();
    const batch: { _id: number } = await (await queued).json();
    const mine = output.locator(`a[href="/generations/${batch._id}"]`).first();
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await expect(output.getByText(/ \/ 2$/)).toBeVisible();
    await output.getByRole("button", { name: "Clear output", exact: true }).click();

    // Done, and still there.
    await expect(output.getByText(/ \/ \d+$/)).toHaveCount(0, { timeout: 60_000 });
    await expect(mine).toBeVisible();
    await page.reload();
    await expect(panels.first()).toBeVisible();
  } finally {
    await request.post(`${COMFY}/fake/run?seconds=${FAKE_COMFY_RUN}`);
  }
});

test("Clean up takes out repeated tags and stray commas, and Ctrl+Z brings them back", async ({ page }) => {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  const messy = "1girl,, smile, red hair, smile ,";
  await prompt.fill(messy);
  const clean = page.getByRole("button", { name: "Clean up" });
  await clean.click();
  await expect(prompt).toHaveValue("1girl, smile, red hair");
  await expect(clean).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(prompt).toHaveValue(messy);
});

test("Use canonical tags swaps every alias in the Prompt, and Ctrl+Z brings them back", async ({ page }) => {
  // Danbooru's list is a download: answer for the board instead.
  await page.route("**/api/v1/tags/place", async (route) => {
    const { names } = route.request().postDataJSON() as { names: string[] };
    const aliases: Record<string, string> = { eyes_closed: "closed_eyes", longhair: "long_hair" };
    await route.fulfill({
      json: {
        list: true,
        fetching: false,
        names: Object.fromEntries(names.map((n) => [n, { section: "other", ...(aliases[n] ? { alias_of: aliases[n] } : {}) }])),
      },
    });
  });
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  const written = "1girl, (eyes_closed:1.2), longhair";
  await prompt.fill(written);
  const swap = page.getByRole("button", { name: "Use canonical tags" });
  await swap.click();
  await expect(prompt).toHaveValue("1girl, (closed eyes:1.2), long hair");
  await expect(swap).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(prompt).toHaveValue(written);
});

test("after a click on + the arrow keys go on stepping", async ({ page }) => {
  await page.goto("/generate");
  const images = page.getByRole("spinbutton", { name: "Images", exact: true });
  await images.fill("4");
  await page.getByRole("button", { name: "More Images" }).click();
  await expect(images).toHaveValue("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowUp");
  await expect(images).toHaveValue("7");
  await page.keyboard.press("ArrowLeft");
  await expect(images).toHaveValue("6");
});
