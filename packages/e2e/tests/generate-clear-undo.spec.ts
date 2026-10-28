import { expect, test, type Page } from "@playwright/test";
import { API } from "./helpers";

// docs/e2e-scenarios.md, "Generate: Tags by part, Clear and Undo".

const START = "1girl, red hair, blue eyes";

async function openBoard(page: Page) {
  await page.goto("/generate");
  const prompt = page.getByLabel("Prompt", { exact: true });
  await prompt.fill(START);
  const board = page.getByLabel("Prompt board");
  await expect(board.getByRole("button", { name: "Remove red hair" })).toBeVisible();
  return { prompt, board };
}

async function clearHair(page: Page, board: ReturnType<Page["getByLabel"]>) {
  await board.getByText("Hair", { exact: true }).hover();
  await board.getByRole("button", { name: "Clear Hair" }).click();
  await expect(page.getByText("Cleared Hair")).toBeVisible();
}

test("Clear takes the box's tags out of the Prompt", async ({ page }) => {
  const { prompt, board } = await openBoard(page);
  await clearHair(page, board);
  await expect(prompt).not.toHaveValue(/red hair/);
  await expect(prompt).toHaveValue(/1girl/);
  await expect(prompt).toHaveValue(/blue eyes/);
  await expect(board.getByRole("button", { name: "Remove red hair" })).toHaveCount(0);
});

test("Undo leaves text typed since untouched", async ({ page }) => {
  const { prompt, board } = await openBoard(page);
  await clearHair(page, board);

  await prompt.press("ControlOrMeta+End");
  await prompt.pressSequentially(", smile");
  await expect(prompt).toHaveValue(/smile/);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(prompt).toHaveValue(/smile/);
  await expect(prompt).not.toHaveValue(/red hair/);
});

test("Undo on an untouched Prompt restores it exactly", async ({ page }) => {
  const { prompt, board } = await openBoard(page);
  await clearHair(page, board);
  await expect(prompt).not.toHaveValue(START);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(prompt).toHaveValue(START);
});

test("after the toast expires there is no Undo and Clear stays", async ({ page }) => {
  await page.clock.install();
  const { prompt, board } = await openBoard(page);
  await clearHair(page, board);

  // Run the clock until the toast goes, however long it is meant to last.
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return page.getByText("Cleared Hair").count();
    })
    .toBe(0);
  await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
  await expect(prompt).not.toHaveValue(/red hair/);
});

test("Clear then Undo with a character and outfit", async ({ page, request }) => {
  // A hand-made character (the fixture images carry the tag); 409 on a retry.
  const made = await request.post(`${API}/tags/characters`, { data: { tag: "frieren", name: "Frieren" } });
  expect([200, 409]).toContain(made.status());
  // Wearing an outfit whose earrings were already struck and with a scarf
  // added for this batch.
  await page.addInitScript((draft) => localStorage.setItem("moire.generate.draft", JSON.stringify(draft)), {
    characters: ["frieren"],
    prompt: "1girl, smile",
    outfits: {
      frieren: {
        id: "e2e",
        name: "Robe",
        tags: ["white_capelet", "black_pantyhose", "earrings", "scarf"],
        dropped: ["earrings"],
        added: ["scarf"],
      },
    },
  });
  await page.goto("/generate");
  const board = page.getByLabel("Prompt board");
  const worn = (tag: string) => board.getByRole("button", { name: `Remove ${tag}` });
  const struck = (tag: string) => board.getByRole("button", { name: `Bring back ${tag}` });
  await expect(worn("white capelet")).toBeVisible();
  await expect(worn("scarf")).toBeVisible();
  await expect(struck("earrings")).toBeVisible();

  await board.getByText("Attire", { exact: true }).hover();
  await board.getByRole("button", { name: "Clear Attire" }).click();
  await expect(struck("white capelet")).toBeVisible();
  await expect(struck("black pantyhose")).toBeVisible();
  await expect(board.getByText("scarf", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(worn("white capelet")).toBeVisible();
  await expect(worn("black pantyhose")).toBeVisible();
  await expect(worn("scarf")).toBeVisible();
  await expect(struck("earrings")).toBeVisible();
});
