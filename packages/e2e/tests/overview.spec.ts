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
  await expect(activity.getByRole("img", { name: "Images generated per day" })).toBeVisible();

  const library = page.getByRole("region", { name: "Library" });
  await expect(library.getByText(/AI-tagged|AI tagging/)).toBeVisible();
  await library.getByRole("link", { name: /librar(y|ies)$/ }).click();
  await expect(page).toHaveURL(/\/libraries$/);
});
