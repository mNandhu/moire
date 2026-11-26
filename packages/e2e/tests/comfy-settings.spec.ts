import { expect, test } from "@playwright/test";
import { API } from "./helpers";

// The ComfyUI section's folder fields: saving one keeps what is typed in the
// other, and a saved field shows what the server stored, even when that is
// the value it already had (a trailing slash cleaned off). The settings are
// answered here, so the sandbox's real folders stay as the Generate specs
// set them.
test("saving one ComfyUI folder keeps the other's typing and shows what was stored", async ({ page, request }) => {
  const current = await (await request.get(`${API}/generate/comfyui`)).json();
  await page.route(`**${API}/generate/comfyui`, async (route) => {
    const req = route.request();
    if (req.method() === "PUT") {
      const patch = req.postDataJSON();
      if (typeof patch.output_root === "string") current.output_root = patch.output_root.replace(/\/+$/, "");
    } else if (req.method() !== "GET") {
      return route.fallback();
    }
    await route.fulfill({ json: current });
  });

  await page.goto("/settings?section=comfyui");
  const folder = page.getByRole("textbox", { name: "Output folder" });
  const root = page.getByRole("textbox", { name: "ComfyUI saves to" });
  const rootSave = root.locator("xpath=following-sibling::button[1]");
  const saveRoot = async (value: string) => {
    await root.fill(value);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `${API}/generate/comfyui`);
    await rootSave.click();
    await saved;
  };

  await folder.fill("/typed/not/saved");
  await saveRoot("/srv/comfy-out");
  await expect(root).toHaveValue("/srv/comfy-out");
  await expect(folder).toHaveValue("/typed/not/saved");

  // Stored as it already was: the box still takes the stored spelling.
  await saveRoot("/srv/comfy-out/");
  await expect(root).toHaveValue("/srv/comfy-out");
  await expect(rootSave).toBeDisabled();
  await expect(folder).toHaveValue("/typed/not/saved");
});
