import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { isFormField } from "../lib/dom";
import { emptyHistory, recordChange, redoStep, undoStep, type UndoHistory } from "../lib/undoHistory";

/**
 * An undo history for a piece of state, kept by watching it change: every
 * change is a step (typing in one field, one step per burst), unless
 * `quietly` marked it or `skip(prev, next)` says the app made it on its own.
 * `undo` / `redo` set the state back or forward, through `restore` (to
 * clean a value before it returns); `reset` forgets the steps. `onStep` is
 * told each time a new step is recorded (not a burst joining one).
 */
export function useUndoHistory<T>(
  value: T,
  setValue: Dispatch<SetStateAction<T>>,
  {
    skip,
    restore,
    onStep,
  }: { skip?: (prev: T, next: T) => boolean; restore?: (v: T) => T; onStep?: () => void } = {},
) {
  const hist = useRef<UndoHistory<T>>(emptyHistory());
  const prev = useRef(value);
  // The change in flight is undo/redo's own, or one to fold in quietly.
  const applying = useRef(false);
  const quiet = useRef(false);
  const opts = useRef({ skip, restore, onStep });
  opts.current = { skip, restore, onStep };
  // The field an input event came from since the last change: that change
  // is typing in it, or a slider dragged (one step per burst). A change with
  // no input before it (a tag picked from a list, a click) is a step of its
  // own, however it is timed.
  const typed = useRef<EventTarget | null>(null);
  useEffect(() => {
    const onInput = (e: Event) => {
      if (isFormField(e.target)) typed.current = e.target;
    };
    // A click starts something else (a picker's search typed in, then an
    // option clicked, is not that typing).
    const onPointer = () => {
      typed.current = null;
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  useEffect(() => {
    if (value === prev.current) return;
    const was = prev.current;
    prev.current = value;
    if (applying.current) {
      applying.current = false;
      return;
    }
    const q = quiet.current || !!opts.current.skip?.(was, value);
    quiet.current = false;
    const key = typed.current;
    typed.current = null;
    const next = recordChange(hist.current, was, { key, now: Date.now(), quiet: q });
    const stepped = next.past !== hist.current.past;
    hist.current = next;
    if (stepped) opts.current.onStep?.();
  }, [value]);

  const go = useCallback(
    (step: typeof undoStep) => {
      const r = step(hist.current, prev.current);
      if (!r) return false;
      hist.current = r.h;
      const next = opts.current.restore ? opts.current.restore(r.value) : r.value;
      if (next !== prev.current) {
        applying.current = true;
        setValue(next);
      }
      return true;
    },
    [setValue],
  );
  const undo = useCallback(() => go(undoStep), [go]);
  const redo = useCallback(() => go(redoStep), [go]);
  /** The next change is the app's, folded into the step before it (only
   * for a change sure to come: `setQuietly` for one that may not). */
  const quietly = useCallback(() => {
    quiet.current = true;
  }, []);
  /** An update the app makes on its own; marked quiet only if it changes something. */
  const setQuietly = useCallback(
    (update: (v: T) => T) =>
      setValue((v) => {
        const next = update(v);
        if (next !== v) quiet.current = true;
        return next;
      }),
    [setValue],
  );
  const reset = useCallback(() => {
    hist.current = emptyHistory();
  }, []);
  return useMemo(() => ({ undo, redo, quietly, setQuietly, reset }), [undo, redo, quietly, setQuietly, reset]);
}
