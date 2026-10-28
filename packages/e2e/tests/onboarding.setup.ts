import { expect, test as setup } from "@playwright/test";
import { COMFY_PORT, libraries, sandbox, waitForScan } from "./helpers";

// Runs first, on a fresh sandbox: walks the welcome flow, which adds the
// fixture library and connects the fake ComfyUI. Every other spec builds on it.
setup("onboarding adds a library and connects ComfyUI", async ({ page, request }) => {
  // Refuse to run against anything but a fresh sandbox.
  expect(await libraries(request)).toEqual([]);

  const { dir, images } = sandbox();
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole("button", { name: "Set up Moiré" }).click();

  await page.getByLabel("Folder path").fill(dir);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(dir, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const address = page.getByLabel(/Address/);
  await address.fill(`http://127.0.0.1:${COMFY_PORT}`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected. Generate will show in the sidebar.")).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByRole("heading", { name: "AI tagging" })).toBeVisible();
  await page.getByRole("button", { name: "Open Moiré", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);

  await waitForScan(request);
  const libs = await libraries(request);
  expect(libs).toHaveLength(1);
  expect(libs[0].indexed_count).toBe(images);
});
