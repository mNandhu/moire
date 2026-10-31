/**
 * A linear undo history of whole values (Generate's form): the values before
 * each change, and the ones undone since, for redo. Typing in one field is
 * one step however many keys it took, while it keeps going; any other change
 * is a step of its own. Pure.
 */

/** Most steps kept. */
export const HISTORY_LIMIT = 100;
/** Typing in the same field within this long of the last key joins its step. */
export const TYPING_MS = 1500;

export type UndoHistory<T> = {
  past: T[];
  future: T[];
  /** What made the last step (the field typed in), for joining the next. */
  lastKey: unknown;
  lastAt: number;
};

export function emptyHistory<T>(): UndoHistory<T> {
  return { past: [], future: [], lastKey: null, lastAt: 0 };
}

/**
 * `h` after the value changed from `prev`. `key` names what changed it when
 * that was typing (the field), so a burst of it is one step; `quiet` is a
 * change the app made on its own, folded into the step before it.
 */
export function recordChange<T>(
  h: UndoHistory<T>,
  prev: T,
  { key = null, now, quiet = false }: { key?: unknown; now: number; quiet?: boolean },
): UndoHistory<T> {
  if (quiet) return { ...h, lastKey: null };
  if (key != null && key === h.lastKey && now - h.lastAt < TYPING_MS) {
    return { ...h, future: [], lastAt: now };
  }
  return { past: [...h.past, prev].slice(-HISTORY_LIMIT), future: [], lastKey: key, lastAt: now };
}

/** The value to go back to from `cur`, and the history after; null with nothing to undo. */
export function undoStep<T>(h: UndoHistory<T>, cur: T): { h: UndoHistory<T>; value: T } | null {
  if (!h.past.length) return null;
  const value = h.past[h.past.length - 1];
  return { value, h: { past: h.past.slice(0, -1), future: [...h.future, cur], lastKey: null, lastAt: 0 } };
}

/** The value undone last, to go forward to from `cur`; null with nothing to redo. */
export function redoStep<T>(h: UndoHistory<T>, cur: T): { h: UndoHistory<T>; value: T } | null {
  if (!h.future.length) return null;
  const value = h.future[h.future.length - 1];
  return { value, h: { past: [...h.past, cur], future: h.future.slice(0, -1), lastKey: null, lastAt: 0 } };
}

/** Whether a keydown is undo (Ctrl/Cmd+Z), redo (Ctrl/Cmd+Shift+Z, Ctrl+Y)
 * or neither. By the key's place too, so a non-Latin layout still works. */
export function undoKey(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  const latin = /^[a-z]$/.test(key);
  const is = (letter: string) => key === letter || (!latin && e.code === `Key${letter.toUpperCase()}`);
  if (is("z")) return e.shiftKey ? "redo" : "undo";
  if (is("y") && !e.shiftKey) return "redo";
  return null;
}
