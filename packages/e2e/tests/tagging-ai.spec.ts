import { expect, test } from "@playwright/test";
import { API } from "./helpers";

// Runs the real WD tagger (CPU) on a few images. The model (~360 MB) comes
// from the shared model cache; the first run anywhere downloads it.
test("AI tagging a few images from the AI Tagging page", async ({ page, request }) => {
  test.setTimeout(300_000);
  const aiTagged = async () => {
    const res = await request.get(`${API}/images?ai_tagged=1&limit=200`);
    const body = await res.json();
    return (body.items ?? body).length as number;
  };
  expect(await aiTagged()).toBe(0);

  await page.goto("/ai-tagging");
  const limit = page.getByLabel("Most images to tag in one run");
  await limit.fill("3");
  await page.getByRole("button", { name: "Tag 3 images" }).click();

  await expect.poll(aiTagged, { timeout: 240_000, intervals: [2000] }).toBe(3);

  await page.goto("/tags");
  await expect(page.getByRole("link", { name: /^AI tagged 3 images AI-tagged$/ })).toBeVisible();
});
