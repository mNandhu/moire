import { expect, test } from "@playwright/test";

test("Overview leads with the latest session, which steps through its images", async ({ page }) => {
  await page.goto("/overview");
  const latest = page.getByRole("region", { name: "Latest session" });
  await expect(latest.getByText(/\d+ images? · /)).toBeVisible();

  // View session opens its best image, stepping through the session.
  await latest.getByRole("link", { name: "View session" }).click();
  await expect(page).toHaveURL(/\/image\//);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/overview$/);

  // A shelf image opens too.
  const shelf = latest.getByRole("link", { name: /\.png$/ });
  await shelf.first().click();
  await expect(page).toHaveURL(/\/image\//);
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/overview$/);
});

test("Overview's activity and library panels lead on", async ({ page }) => {
  await page.goto("/overview");
  const activity = page.getByRole("region", { name: "Activity" });
  await expect(activity.getByText("Last 30 days")).toBeVisible();
  await expect(activity.getByRole("group", { name: "Images generated per day" })).toBeVisible();

  const library = page.getByRole("region", { name: "Library" });
  await expect(library.getByText(/AI-tagged|AI tagging/)).toBeVisible();
  await library.getByRole("link", { name: /librar(y|ies)$/ }).click();
  await expect(page).toHaveURL(/\/libraries$/);
});

test("A day on the activity calendar opens the gallery of that day", async ({ page }) => {
  await page.goto("/overview");
  const calendar = page.getByRole("group", { name: "Images generated per day" });
  const day = calendar.getByRole("link").last();
  const label = (await day.getAttribute("aria-label"))!;
  const shown = Number(label.match(/(\d+) images?$/)![1]);
  // By keyboard: a day is a link like any other.
  await day.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]made_from=\d+/);
  await expect(page).toHaveURL(/[?&]made_to=\d+/);
  await expect(page.getByRole("button", { name: /^Remove filter: Made / })).toBeVisible();
  await expect(page.locator("[data-tile-index]")).toHaveCount(Math.min(shown, 100));
});

test("Who you've been making leads to a character's page", async ({ page }) => {
  await page.goto("/overview");
  const who = page.getByRole("region", { name: "Who you've been making" });
  const first = who.getByRole("link").first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/characters\//);
});
