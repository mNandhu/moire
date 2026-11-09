import { expect, test } from "@playwright/test";

// The run control's number box: it starts at every image left, and a smaller
// number becomes the run's limit. The request is answered here, so no job runs.
test("the AI Tagging run box sends how many to tag", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/v1/ai/tag-untagged", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { job_id: null, queued: 0 } });
  });

  await page.goto("/ai-tagging");
  const box = page.getByRole("textbox", { name: "Images to tag" });
  await expect(box).toBeVisible();
  const left = Number((await box.inputValue()).replace(/\D/g, ""));
  expect(left).toBeGreaterThan(1);

  // Every image left: no limit, so images that arrive meanwhile join the run.
  await page.getByRole("button", { name: "Tag", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).not.toHaveProperty("limit");

  await box.fill("1");
  await page.getByRole("button", { name: "Tag", exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ limit: 1 });

  // Empty means nothing to tag.
  await box.fill("");
  await expect(page.getByRole("button", { name: "Tag", exact: true })).toBeDisabled();
});
