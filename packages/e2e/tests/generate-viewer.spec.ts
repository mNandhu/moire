import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API } from "./helpers";

// docs/e2e-scenarios.md, "Generate: the viewer steps through the output
// column". Runs after generate-run.spec.ts, which sets the output folder and
// passes the test run.

type Batch = { requests: { outputs: { image_id: string; in_library: boolean }[] }[] };

/** Until no batch is still running or paused: Clear keeps those. */
async function settled(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const list: { state: string }[] = await (await request.get(`${API}/generate/batches?limit=20`)).json();
      return list.filter((b) => b.state === "running" || b.state === "paused").length;
    }, { timeout: 60_000 })
    .toBe(0);
}

/** Queues `n` images and waits until all of them are in the library; their ids, in order. */
async function queue(page: Page, request: APIRequestContext, n: number): Promise<string[]> {
  await page.getByLabel("Prompt", { exact: true }).fill("1girl, smile, garden");
  await page.getByRole("spinbutton", { name: "Images", exact: true }).fill(String(n));
  await expect(page.getByRole("button", { name: /^Queue/ })).toBeEnabled({ timeout: 30_000 });
  const queued = page.waitForResponse((r) => r.request().method() === "POST" && /\/batches$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: /^Queue/ }).click();
  const { _id }: { _id: number } = await (await queued).json();
  let ids: string[] = [];
  await expect
    .poll(async () => {
      const b: Batch = await (await request.get(`${API}/generate/batches/${_id}`)).json();
      const outs = b.requests.flatMap((q) => q.outputs);
      ids = outs.filter((o) => o.in_library).map((o) => o.image_id);
      return ids.length;
    }, { timeout: 60_000 })
    .toBe(n);
  return ids;
}

/** The id of the image the viewer shows. */
const openId = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.replace(/^\/image\//, ""));

test("the viewer steps through only the images Generate shows", async ({ page, request }) => {
  await settled(request);
  await page.goto("/generate");
  const output = page.getByRole("complementary", { name: "Output" });
  const clear = output.getByRole("button", { name: "Clear", exact: true });
  if (await clear.isVisible()) await clear.click();
  await expect(output.getByRole("link", { name: "Batch page" })).toHaveCount(0);

  // One image on show: nothing to step to, though the library has many.
  const [only] = await queue(page, request, 1);
  const tiles = output.locator('a[href^="/image/"]');
  await expect(tiles).toHaveCount(1, { timeout: 30_000 });
  await tiles.first().click();
  await expect.poll(() => openId(page)).toBe(only);
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => openId(page)).toBe(only);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/generate$/);

  // A second batch: Right walks on into it, in the order they were made.
  const later = await queue(page, request, 2);
  await settled(request);
  // The newest batch is on top; the first one made is at the bottom.
  await expect(tiles).toHaveCount(2, { timeout: 30_000 });
  await tiles.last().click();
  await expect.poll(() => openId(page)).toBe(only);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => openId(page)).toBe(later[0]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => openId(page)).toBe(later[1]);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => openId(page)).toBe(only);
});
