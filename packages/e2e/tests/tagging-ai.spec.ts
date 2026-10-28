import { expect, test } from "@playwright/test";
import { API, libraries, sandbox } from "./helpers";

type Row = { _id: string };

// Runs the real WD tagger (CPU) on a few images. The model (~360 MB) is kept
// in the e2e model cache; the first run anywhere downloads it.
test("AI tagging a few images of one library", async ({ page, request }) => {
  test.setTimeout(300_000);
  const fixtures = (await libraries(request)).find((l) => l.path === sandbox().dir);
  expect(fixtures).toBeTruthy();
  const aiTagged = async () => {
    const res = await request.get(`${API}/images?ai_tagged=1&limit=200`);
    const body = await res.json();
    return (body.items ?? body) as Row[];
  };
  const before = (await aiTagged()).length;

  await page.goto("/ai-tagging");
  await page.getByLabel("Most images to tag in one run").fill("3");
  // The fixture library's own row: that library only.
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "images", exact: true }) });
  await row.getByRole("button", { name: "Tag" }).click();

  await expect.poll(async () => (await aiTagged()).length, { timeout: 240_000, intervals: [2000] }).toBe(before + 3);
  const tagged = (await aiTagged()).filter((r) => r._id.startsWith(`${fixtures!._id}:`));
  expect(tagged).toHaveLength(3);

  await page.goto("/tags");
  await expect(page.getByRole("link", { name: `AI tagged ${before + 3} images AI-tagged` })).toBeVisible();
});
