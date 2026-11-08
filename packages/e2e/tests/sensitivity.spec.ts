import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, imageByPath, viewerUrl } from "./helpers";

// The filter is one setting for the whole server: every test here puts it
// back, so the specs after this one see every image.
async function filterOff(request: APIRequestContext) {
  const res = await request.post(`${API}/sensitivity`, { data: { max_level: null } });
  expect(res.ok()).toBeTruthy();
}

async function rate(request: APIRequestContext, id: string, rating: string) {
  const res = await request.post(`${API}/images/${encodeURIComponent(id)}/rating`, { data: { rating } });
  expect(res.ok()).toBeTruthy();
}

test.afterEach(async ({ request }) => {
  await filterOff(request);
});

test("the header shield hides images above the level, and says so on a direct link", async ({ page, request }) => {
  const { _id } = await imageByPath(request, "frieren/frieren_31.png");
  await rate(request, _id, "explicit");
  try {
    await page.goto("/");
    const shield = page.getByRole("button", { name: "Sensitivity filter" });
    await shield.click();
    await page.getByRole("option", { name: /^Up to questionable/ }).click();

    // The fixtures' prompts name nothing listed: they wait for AI tagging.
    await expect(page.getByRole("status").filter({ hasText: "hidden until AI-tagged" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tag them" })).toBeVisible();

    await page.goto(viewerUrl(_id));
    await expect(page.getByText("Hidden by the sensitivity filter")).toBeVisible();

    // Back to everything: the image opens again.
    await page.goto("/");
    await page.getByRole("button", { name: "Sensitivity filter" }).click();
    await page.getByRole("option", { name: /^Show everything/ }).click();
    await page.goto(viewerUrl(_id));
    await expect(page.getByText("Hidden by the sensitivity filter")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change rating" })).toBeVisible();
  } finally {
    await rate(request, _id, "-");
  }
});

test("Settings sets this library's level for a tag, and drops it", async ({ page }) => {
  await page.goto("/settings?section=sensitivity");
  await expect(page.getByRole("heading", { name: "Tag levels" })).toBeVisible();
  await page.getByRole("textbox", { name: "Tag" }).fill("e2e level word");
  await page.getByRole("button", { name: "Level", exact: true }).click();
  await page.getByRole("option", { name: "questionable" }).click();
  await page.getByRole("button", { name: "Add" }).click();

  const level = page.getByRole("button", { name: "Level of e2e level word" });
  await expect(level).toContainText("questionable");
  await level.click();
  await page.getByRole("option", { name: "explicit" }).click();
  await expect(level).toContainText("explicit");

  await page.getByRole("button", { name: "Remove e2e level word" }).click();
  await expect(level).toHaveCount(0);
});
