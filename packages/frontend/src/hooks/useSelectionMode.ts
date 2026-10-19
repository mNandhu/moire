import { useCallback, useEffect, useState } from "react";

/**
 * Multi-select state for the gallery: the selected id set, whether selection
 * mode is on, and toggle/clear. Leaving selection mode drops the selection.
 *
 * Pure state (a Set + a boolean) lifted out of AllImagesPage so the
 * toggle/clear/auto-clear behaviour is testable on its own.
 */
export function useSelectionMode() {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  const toggle = useCallback((id: string) => {
    setSelection((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const clear = useCallback(() => setSelection(new Set()), []);
  /** Replace the selection ("Select all"). */
  const selectOnly = useCallback((ids: Iterable<string>) => setSelection(new Set(ids)), []);
  const selectionActive = selection.size > 0;

  // When leaving selection mode, drop the current selection.
  useEffect(() => {
    if (!selectionMode && selectionActive) setSelection(new Set());
  }, [selectionMode, selectionActive]);

  return {
    selection,
    selectionMode,
    setSelectionMode,
    selectionActive,
    toggle,
    clear,
    selectOnly,
  };
}
