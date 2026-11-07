import { describe, expect, it } from "vitest";
import { emptyTimeline, pushStep, takeRedo, takeUndo, type TimelineStep } from "./undoTimeline";

const form: TimelineStep = { kind: "form" };
const act: TimelineStep = { kind: "action", action: { undo: () => {}, redo: () => {} } };

describe("undo timeline", () => {
  it("undoes the last step first, then redoes it", () => {
    let t = pushStep(pushStep(emptyTimeline(), form), act);
    const u = takeUndo(t)!;
    expect(u.step).toBe(act);
    t = u.t;
    expect(takeUndo(t)!.step).toBe(form);
    const r = takeRedo(t)!;
    expect(r.step).toBe(act);
    expect(r.t.past).toEqual([form, act]);
  });

  it("forgets what was undone once a new step comes", () => {
    const t = takeUndo(pushStep(emptyTimeline(), act))!.t;
    expect(takeRedo(pushStep(t, form))).toBeNull();
  });

  it("has nothing to undo or redo when empty", () => {
    expect(takeUndo(emptyTimeline())).toBeNull();
    expect(takeRedo(emptyTimeline())).toBeNull();
  });
});
