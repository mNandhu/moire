import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../Toasts";
import { PresetDialogShell } from "./PresetDialogShell";
import { PresetPicker } from "./PresetPicker";

function shell(props: Partial<React.ComponentProps<typeof PresetDialogShell<{ id: number }>>> = {}) {
  const client = new QueryClient();
  const spy = vi.spyOn(client, "invalidateQueries");
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const save = vi.fn(async () => ({ id: 1 }));
  const remove = vi.fn(async () => undefined);
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PresetDialogShell
          title="New preset"
          editing={false}
          name="Soft"
          onName={() => undefined}
          canSave
          queryKey={["presets"]}
          save={save}
          remove={remove}
          onClose={onClose}
          onSaved={onSaved}
          {...props}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { spy, onSaved, onClose, save, remove };
}

describe("PresetDialogShell", () => {
  it("saves, refreshes the presets, reports the preset and closes", async () => {
    const { spy, onSaved, onClose, save } = shell();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(save).toHaveBeenCalledOnce();
    expect(onSaved).toHaveBeenCalledWith({ id: 1 });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["presets"] });
  });

  it("offers Delete only when editing", () => {
    shell();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("deletes an edited preset", async () => {
    const { onSaved, remove } = shell({ editing: true });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null));
    expect(remove).toHaveBeenCalledOnce();
  });

  it("will not save without a name or valid fields", () => {
    shell({ name: "  " });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("will not save when the kind's fields are invalid", () => {
    shell({ canSave: false });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open and toasts when saving fails", async () => {
    const { onClose } = shell({ save: async () => Promise.reject(new Error("Name taken")) });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Name taken")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("PresetPicker", () => {
  const presets = [
    { _id: "a", name: "Soft", text: "soft light" },
    { _id: "b", name: "Hard", text: "hard light" },
  ];

  it("shows the selected preset and picks through to the caller", () => {
    const onPick = vi.fn();
    render(<PresetPicker presets={presets} loaded value="a" onPick={onPick} onNew={() => undefined} aria-label="Prefix preset" />);
    fireEvent.click(screen.getByRole("button", { name: /Prefix preset/ }));
    fireEvent.mouseDown(screen.getByText("Hard"));
    expect(onPick).toHaveBeenCalledWith(presets[1]);
  });

  it("offers None and New", () => {
    const onPick = vi.fn();
    const onNew = vi.fn();
    render(<PresetPicker presets={presets} loaded value="a" onPick={onPick} onNew={onNew} aria-label="Prefix preset" />);
    fireEvent.click(screen.getByRole("button", { name: /Prefix preset/ }));
    fireEvent.mouseDown(screen.getByText("New preset"));
    expect(onNew).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Prefix preset/ }));
    fireEvent.mouseDown(screen.getByText("None"));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
