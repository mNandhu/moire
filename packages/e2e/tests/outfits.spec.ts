import { expect, test, type APIRequestContext } from "@playwright/test";
import { API } from "./helpers";

/** A hand-made character (the fixture images carry the tag); 409 when an
 * earlier spec made it. */
async function character(request: APIRequestContext, tag: string, name: string) {
  const made = await request.post(`${API}/tags/characters`, { data: { tag, name } });
  expect([200, 409]).toContain(made.status());
}

test("Outfits page: New outfit for a character, shared with everyone", async ({ page, request }) => {
  await character(request, "frieren", "Frieren");
  await page.goto("/outfits");
  await page.getByRole("button", { name: "New outfit" }).click();
  const dialog = page.getByRole("dialog", { name: "New outfit" });
  const create = dialog.getByRole("button", { name: "Create outfit" });
  await expect(create).toBeDisabled();

  await dialog.getByRole("button", { name: "Character" }).click();
  await page.getByRole("option").filter({ hasText: "Frieren" }).first().click();
  const add = dialog.getByLabel("Add outfit tag");
  await add.fill("e2e_red_scarf");
  await add.press("Enter");
  await expect(dialog.getByRole("button", { name: /e2e red scarf/ })).toBeVisible();
  await dialog.getByLabel("Name").fill("E2E scarf");
  await dialog.getByText("Available for all characters").click();
  await create.click();
  await expect(dialog).toHaveCount(0);

  const card = page.getByRole("button", { name: "E2E scarf actions" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Shared")).toBeVisible();
  await expect(card.getByText("From Frieren, any character")).toBeVisible();
});

test("Generate: the Outfit picker lists other characters' outfits too", async ({ page, request }) => {
  await character(request, "frieren", "Frieren");
  await character(request, "e2e_rival", "Rival");
  const made = await request.post(`${API}/generate/outfits`, {
    data: { name: "Rival coat", character: "e2e_rival", tags: ["e2e_long_coat"] },
  });
  expect(made.ok()).toBeTruthy();
  await page.addInitScript((draft) => localStorage.setItem("moire.generate.draft", JSON.stringify(draft)), {
    characters: ["frieren"],
    prompt: "1girl",
  });
  await page.goto("/generate");
  await page.getByRole("button", { name: "Outfit", exact: true }).first().click();
  const option = page.getByRole("option").filter({ hasText: "Rival coat" });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByRole("button", { name: "Outfit", exact: true }).first()).toContainText("Rival coat");
});
