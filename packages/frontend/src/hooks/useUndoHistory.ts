import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { isFormField } from "../lib/dom";
import { emptyHistory, recordChange, redoStep, undoStep, type UndoHistory } from "../lib/undoHistory";

/**
 * An undo history for a piece of state, kept by watching it change: every
 * change is a step (typing in one field, one step per burst), unless
 * `quietly` marked it or `skip(prev, next)` says the app made it on its own.
 * `undo` / `redo` set the state back or forward, through `restore` (to
 * clean a value before it returns); `reset` forgets the steps.
 */
export function useUndoHistory<T>(
  value: T,
  setValue: Dispatch<SetStateAction<T>>,
  { skip, restore }: { skip?: (prev: T, next: T) => boolean; restore?: (v: T) => T } = {},
) {
  const hist = useRef<UndoHistory<T>>(emptyHistory());
  const prev = useRef(value);
  // The change in flight is undo/redo's own, or one to fold in quietly.
  const applying = useRef(false);
  const quiet = useRef(false);
  const opts = useRef({ skip, restore });
  opts.current = { skip, restore };

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
    const el = document.activeElement;
    hist.current = recordChange(hist.current, was, { key: isFormField(el) ? el : null, now: Date.now(), quiet: q });
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
  /** The next change is the app's, folded into the step before it. */
  const quietly = useCallback(() => {
    quiet.current = true;
  }, []);
  const reset = useCallback(() => {
    hist.current = emptyHistory();
  }, []);
  return useMemo(() => ({ undo, redo, quietly, reset }), [undo, redo, quietly, reset]);
}
