import { expect, test, type APIRequestContext } from "@playwright/test";
import { API, imageByPath } from "./helpers";

/** A hand-made character (the fixture images carry the tag); 409 when an
 * earlier spec made it. */
async function character(request: APIRequestContext, tag: string, name: string) {
  const made = await request.post(`${API}/tags/characters`, { data: { tag, name } });
  expect([200, 409]).toContain(made.status());
}

/** A Frieren fixture image dressed in `tags` (by hand), so it takes over a
 * starter's cover for her; its id. */
async function wearing(request: APIRequestContext, tags: string[]): Promise<string> {
  const { _id } = await imageByPath(request, "frieren/frieren_57.png");
  const res = await request.post(`${API}/tags/apply/${encodeURIComponent(_id)}`, { data: tags });
  expect(res.ok()).toBeTruthy();
  return _id;
}

/** Frieren's saved outfit called `name`. */
async function savedOutfit(request: APIRequestContext, name: string) {
  const listed = await (await request.get(`${API}/generate/outfits?character=frieren`)).json();
  return listed.find((o: { name: string }) => o.name === name);
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

test("Generate: a starter outfit is worn as it is, then saved as the character's own", async ({ page, request }) => {
  await character(request, "frieren", "Frieren");
  const dressed = await wearing(request, ["maid", "maid_headdress", "dress", "apron", "puffy_short_sleeves", "frills", "thighhighs", "mary_janes"]);
  await page.addInitScript((draft) => localStorage.setItem("moire.generate.draft", JSON.stringify(draft)), {
    characters: ["frieren"],
    prompt: "1girl",
  });
  await page.goto("/generate");
  const outfit = page.getByRole("button", { name: "Outfit", exact: true }).first();
  await outfit.click();
  await page.getByLabel("Search options").fill("Maid dress");
  await page.getByRole("option").filter({ hasText: "Maid dress" }).first().click();
  await expect(outfit).toContainText("Maid dress");

  await page.getByRole("button", { name: "More" }).first().click();
  await page.getByRole("button", { name: "Save as my outfit" }).click();
  const dialog = page.getByRole("dialog", { name: /Save outfit/ });
  await expect(dialog.getByLabel("Name")).toHaveValue("Maid dress");
  await expect(dialog.getByRole("button", { name: /maid headdress/ })).toBeVisible();
  await dialog.getByLabel("Name").fill("E2E maid");
  await dialog.getByRole("button", { name: "Save outfit" }).click();
  await expect(dialog).toHaveCount(0);
  // Now wearing the saved copy, one of Frieren's own.
  await expect(outfit).toContainText("E2E maid");
  const saved = await savedOutfit(request, "E2E maid");
  expect(saved?.character).toBe("frieren");
  expect(saved?.tags.map((t: { tag: string }) => t.tag)).toContain("maid_headdress");
  // Her own image wearing it is the copy's cover.
  expect(saved?.image_id).toBe(dressed);
});

test("Outfits page: the starter outfits by category, one saved as a copy", async ({ page, request }) => {
  await character(request, "frieren", "Frieren");
  const dressed = await wearing(request, ["wizard_hat", "robe", "hood", "belt", "boots", "gloves"]);
  await page.goto("/outfits");
  const starters = page.getByRole("region", { name: "Starter outfits" });
  await expect(starters.getByRole("heading", { name: "school", exact: true })).toBeVisible();
  await page.getByLabel("Search outfits").fill("Wizard robe");
  const card = starters.getByRole("button", { name: "Wizard robe actions" });
  await expect(card).toBeVisible();
  await expect(card.locator("img")).toHaveAttribute("src", /\/starters\/wizard-robe\/cover\?v=/);

  await card.click();
  await page.getByRole("menuitem", { name: "Save as outfit" }).click();
  const dialog = page.getByRole("dialog", { name: /Save outfit/ });
  const save = dialog.getByRole("button", { name: "Save outfit" });
  await expect(save).toBeDisabled();
  await dialog.getByRole("button", { name: "Character" }).click();
  await page.getByRole("option").filter({ hasText: "Frieren" }).first().click();
  await expect(dialog.getByLabel("Name")).toHaveValue("Wizard robe");
  await save.click();
  await expect(dialog).toHaveCount(0);
  // The copy joins the saved outfits; the starter stays below.
  await expect(page.getByRole("button", { name: "Wizard robe actions" })).toHaveCount(2);
  await expect(starters.getByRole("button", { name: "Wizard robe actions" })).toHaveCount(1);
  // Picked in the dialog, her own image wearing it became the cover.
  expect((await savedOutfit(request, "Wizard robe"))?.image_id).toBe(dressed);

  // Its gallery filter reads as its name, not its id.
  await starters.getByRole("button", { name: "Wizard robe actions" }).click();
  await page.getByRole("menuitem", { name: "Open in gallery" }).click();
  await expect(page).toHaveURL(/outfit=starter%3Awizard-robe|outfit=starter:wizard-robe/);
  await expect(page.getByRole("button", { name: /^Remove .*Wizard robe$/ })).toBeVisible();
});
