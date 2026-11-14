import { describe, expect, it } from "vitest";
import { HISTORY_LIMIT, TYPING_MS, emptyHistory, recordChange, redoStep, undoKey, undoStep } from "./undoHistory";

describe("undo history", () => {
  it("undoes and redoes each change in turn", () => {
    let h = emptyHistory<string>();
    h = recordChange(h, "a", { now: 0 });
    h = recordChange(h, "b", { now: 1 });
    // Now at "c".
    const u1 = undoStep(h, "c")!;
    expect(u1.value).toBe("b");
    const u2 = undoStep(u1.h, "b")!;
    expect(u2.value).toBe("a");
    expect(undoStep(u2.h, "a")).toBeNull();
    const r1 = redoStep(u2.h, "a")!;
    expect(r1.value).toBe("b");
    expect(redoStep(r1.h, "b")!.value).toBe("c");
  });

  it("a new change drops what was undone", () => {
    let h = recordChange(emptyHistory<string>(), "a", { now: 0 });
    h = undoStep(h, "b")!.h;
    h = recordChange(h, "a", { now: 5 });
    expect(redoStep(h, "x")).toBeNull();
  });

  it("joins a burst of typing in one field, not two removals", () => {
    const field = {};
    let h = recordChange(emptyHistory<string>(), "", { key: field, now: 0 });
    h = recordChange(h, "h", { key: field, now: 100 });
    h = recordChange(h, "hi", { key: field, now: 200 });
    expect(h.past).toEqual([""]);
    // A pause past the window starts a new step.
    h = recordChange(h, "hi there", { key: field, now: 200 + TYPING_MS });
    expect(h.past).toEqual(["", "hi there"]);
    // Clicks carry no key: one step each.
    h = recordChange(h, "x", { now: 10_000 });
    h = recordChange(h, "y", { now: 10_001 });
    expect(h.past.slice(-2)).toEqual(["x", "y"]);
  });

  it("folds a quiet change into the step before", () => {
    let h = recordChange(emptyHistory<string>(), "a", { now: 0 });
    h = recordChange(h, "b", { now: 1, quiet: true });
    expect(h.past).toEqual(["a"]);
  });

  it("keeps at most the limit", () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = recordChange(h, i, { now: i });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]).toBe(10);
  });
});

describe("undoKey", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, code?: string) =>
    undoKey({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  it("reads Ctrl or Cmd Z, Shift for redo, Ctrl Y", () => {
    expect(k("z", { ctrlKey: true })).toBe("undo");
    expect(k("z", { metaKey: true })).toBe("undo");
    expect(k("Z", { ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(k("y", { ctrlKey: true })).toBe("redo");
    expect(k("z")).toBeNull();
    expect(k("z", { ctrlKey: true, altKey: true })).toBeNull();
  });
  it("finds the key by its place on another layout", () => {
    expect(k("я", { ctrlKey: true }, "KeyZ")).toBe("undo");
  });
});
