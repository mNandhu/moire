import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TagEditDialog } from "./TagEditDialog";
import type { CharacterPage } from "../lib/character";

const push = vi.fn();
const updateCharacter = vi.fn();
vi.mock("./Toasts", () => ({ useToast: () => ({ push }) }));
vi.mock("../lib/tagMutations", () => ({
  setTagFocus: vi.fn(),
  updateCharacter: (...args: unknown[]) => updateCharacter(...args),
}));

const page = { tag: "scarf", focus: null, thumb_url: null } as unknown as CharacterPage;

function open(onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TagEditDialog open onClose={onClose} c={page} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("This is a character"));
  return onClose;
}

describe("TagEditDialog save", () => {
  it("un-sticks the button after a failed save and keeps the dialog open", async () => {
    updateCharacter.mockRejectedValueOnce(new Error("boom"));
    const onClose = open();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.click(save);
    await waitFor(() => expect(push).toHaveBeenCalledWith("Couldn't save: boom", "error"));
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();

    updateCharacter.mockResolvedValueOnce({});
    fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
