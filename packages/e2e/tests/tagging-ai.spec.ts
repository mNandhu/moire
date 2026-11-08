import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
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
  const ofFixtures = (rows: Row[]) => rows.filter((r) => r._id.startsWith(`${fixtures!._id}:`));
  const before = (await aiTagged()).length;
  // An earlier spec may have tagged some (a cancelled job finishes its image).
  const fixturesBefore = ofFixtures(await aiTagged()).length;

  await page.goto("/ai-tagging");
  await page.getByLabel("Most images to tag in one run").fill("3");
  // The fixture library's own row: that library only.
  const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: "images", exact: true }) });
  await row.getByRole("button", { name: "Tag" }).click();

  await expect.poll(async () => (await aiTagged()).length, { timeout: 240_000, intervals: [2000] }).toBe(before + 3);
  expect(ofFixtures(await aiTagged())).toHaveLength(fixturesBefore + 3);

  await page.goto("/tags");
  await expect(page.getByRole("link", { name: `AI tagged ${before + 3} images AI-tagged` })).toBeVisible();
});

test("New character: a picture fills identity and Default outfit", async ({ page }) => {
  test.setTimeout(180_000);
  const dir = path.join(sandbox().dir, "frieren");
  const picture = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".png"))!);

  await page.goto("/tags");
  await page.getByRole("button", { name: "New character" }).click();
  const dialog = page.getByRole("dialog", { name: "New character" });
  await dialog.getByLabel("Picture to tag").setInputFiles(picture);

  // The model is loaded by the run above, or loads now. Each list fills
  // with removable chips: hair or eyes for identity, clothes for the outfit.
  const box = (label: string) => dialog.getByLabel(`Add ${label} tag`).locator("xpath=../..");
  await expect(box("identity").getByRole("button", { name: /^Remove / }).first()).toBeVisible({ timeout: 120_000 });
  await expect(box("default outfit").getByRole("button", { name: /^Remove / }).first()).toBeVisible();
  // The tagger named who it is.
  await expect(dialog.getByLabel("Tag", { exact: true })).not.toHaveValue("");

  await dialog.getByRole("button", { name: "Cancel" }).click();
});
