import { expect, test } from "@playwright/test";

// Tabs that don't fit the row go under More, which names the open one.
test("Settings tabs past the row's width open from More", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto("/settings?section=tagging");
  const tabs = page.getByRole("navigation", { name: "Settings sections" });
  await expect(tabs.getByRole("button", { name: "AI Tagging" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "About" })).toHaveCount(0);

  await page.getByRole("button", { name: "More settings" }).click();
  await page.getByRole("menuitem", { name: "About" }).click();
  await expect(page).toHaveURL(/section=about/);
  await expect(page.getByText(/^Version \d/)).toBeVisible();
  await expect(page.getByRole("button", { name: "More settings" })).toHaveText(/About/);
});
