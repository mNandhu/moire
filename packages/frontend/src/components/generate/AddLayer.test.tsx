import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AddLayer } from "./Layers";

describe("AddLayer", () => {
  it("opens a menu of layer kinds and adds the one picked", () => {
    const onAdd = vi.fn();
    render(<AddLayer onAdd={onAdd} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a layer here" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Text", "Preset", "Embedding"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Embedding" }));
    expect(onAdd).toHaveBeenCalledWith("embedding");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Character first when another can be added", () => {
    const onCharacter = vi.fn();
    render(<AddLayer onAdd={() => undefined} onCharacter={onCharacter} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a layer here" }));
    expect(screen.getAllByRole("menuitem")[0].textContent).toBe("Character");
    fireEvent.click(screen.getByRole("menuitem", { name: "Character" }));
    expect(onCharacter).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render(<AddLayer onAdd={() => undefined} />);
    const trigger = screen.getByRole("button", { name: "Add a layer here" });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
