import { expect, test } from "@playwright/test";

// The sandbox is a source checkout, which never asks PyPI, so the version
// endpoint is answered here as an installed copy with a release waiting.
const STATUS = {
  current: "0.2.1",
  latest: "0.3.0",
  update_available: true,
  release_url: "https://github.com/mNandhu/moire/releases/tag/v0.3.0",
  command: "uv tool upgrade moire-studio",
  install_kind: "uv",
  can_check: true,
  enabled: true,
  checked_at: Date.now() / 1000 - 2 * 3600,
};

test("the sidebar offers a waiting update until Later", async ({ page }) => {
  await page.route("**/api/v1/version", (route) => route.fulfill({ json: STATUS }));
  await page.goto("/overview");
  // A dismissal from an earlier run would hide it.
  await page.evaluate(() => localStorage.removeItem("update:dismissed"));
  await page.reload();

  const row = page.getByRole("button", { name: /Update available/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText("Moiré 0.3.0 is out")).toBeVisible();
  await expect(page.getByText("uv tool upgrade moire-studio")).toBeVisible();
  await expect(page.getByRole("link", { name: "What's new" })).toHaveAttribute("href", STATUS.release_url);

  await page.getByRole("button", { name: "Later" }).click();
  await expect(row).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: /Update available/ })).toBeHidden();

  // Settings > About still shows it.
  await page.goto("/settings?section=about");
  await expect(page.getByText("Version 0.2.1")).toBeVisible();
  await expect(page.getByText("Moiré 0.3.0 is out")).toBeVisible();
  await expect(page.getByText("Last checked 2 h ago.")).toBeVisible();
  // The version is in the heading; the update box doesn't repeat it.
  await expect(page.getByText("You have 0.2.1.")).toBeHidden();
});

test("About's switch turns the update check off", async ({ page }) => {
  let sent: unknown = null;
  await page.route("**/api/v1/version", async (route) => {
    if (route.request().method() === "PUT") {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { ...STATUS, enabled: false, update_available: false, latest: null } });
    }
    return route.fulfill({ json: STATUS });
  });
  await page.goto("/settings?section=about");
  const sw = page.getByRole("switch", { name: "Check for updates" });
  await sw.click();
  await expect.poll(() => sent).toEqual({ enabled: false });
  await expect(page.getByText("Moiré 0.3.0 is out")).toBeHidden();
  await expect(page.getByRole("button", { name: "Check now" })).toBeHidden();
});

test("a source checkout shows its version and no update check", async ({ page }) => {
  await page.goto("/settings?section=about");
  await expect(page.getByText(/^Version \d/)).toBeVisible();
  await expect(page.getByRole("switch", { name: "Check for updates" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Update available/ })).toBeHidden();
});
