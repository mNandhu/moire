/**
 * One undo order for a page whose form keeps its own history (Generate) but
 * which also does things outside the form (rejecting an image): each step
 * is the form's next one, or an action that knows how to undo and redo
 * itself. Ctrl+Z undoes whichever came last. Pure.
 */
export type UndoAction = { undo: () => unknown; redo: () => unknown };

export type TimelineStep = { kind: "form" } | { kind: "action"; action: UndoAction };

export type Timeline = { past: TimelineStep[]; future: TimelineStep[] };

/** Most steps kept. */
export const TIMELINE_LIMIT = 200;

export const emptyTimeline = (): Timeline => ({ past: [], future: [] });

/** `t` after a new step: what was undone can't be redone any more. */
export function pushStep(t: Timeline, step: TimelineStep): Timeline {
  return { past: [...t.past, step].slice(-TIMELINE_LIMIT), future: [] };
}

/** The step to undo, and the timeline after; null with nothing to undo. */
export function takeUndo(t: Timeline): { step: TimelineStep; t: Timeline } | null {
  const step = t.past[t.past.length - 1];
  return step ? { step, t: { past: t.past.slice(0, -1), future: [...t.future, step] } } : null;
}

/** The step to redo, and the timeline after; null with nothing to redo. */
export function takeRedo(t: Timeline): { step: TimelineStep; t: Timeline } | null {
  const step = t.future[t.future.length - 1];
  return step ? { step, t: { past: [...t.past, step], future: t.future.slice(0, -1) } } : null;
}
