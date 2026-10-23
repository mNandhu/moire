import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useBoilerplate } from "../lib/queries";
import { rankSuggestions, suggestKeyAction, type TagSuggestion } from "../lib/tagSuggest";

const NONE: TagSuggestion[] = [];

/** {@link rankSuggestions} with the user's boilerplate list. Loras and
 * embeddings only where the caller offers them (the gallery search). */
export function useTagMatches(
  text: string,
  pool: readonly TagSuggestion[],
  resources: readonly TagSuggestion[] = NONE,
): TagSuggestion[] {
  const isBoilerplate = useBoilerplate();
  return useMemo(
    () => rankSuggestions(text, pool, resources, isBoilerplate),
    [text, pool, resources, isBoilerplate],
  );
}

/**
 * The keyboard half of a suggestion list: the highlighted row, whether the
 * user has arrowed to it, and the keys. `onKeyDown(e)` returns true when it
 * consumed the key (Up/Down move, Enter and optionally Tab take the
 * highlighted row through `onPick`, Escape calls `onClose`), so a caller
 * keeps only its own extras (comma, Backspace, submitting free text).
 *
 * `open` is whether the list is showing. `enter` is "highlight" when Enter
 * always takes the highlighted row, "moved" when it does only after an arrow
 * key (so typed text can still be committed). The highlight resets when
 * `resetKey` changes (the typed text); callers without one call `reset`.
 * `ariaProps` is the combobox markup for the input: with the list open it
 * is a popup, so a Dialog leaves Escape to it.
 */
export function useSuggestNav({
  matches,
  open,
  onPick,
  onClose,
  enter = "highlight",
  tab = false,
  resetKey,
}: {
  matches: readonly TagSuggestion[];
  open: boolean;
  onPick: (s: TagSuggestion) => void;
  onClose?: () => void;
  enter?: "highlight" | "moved";
  tab?: boolean;
  resetKey?: unknown;
}) {
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const reset = useCallback(() => {
    setActive(0);
    setMoved(false);
  }, []);
  useEffect(reset, [resetKey, reset]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): boolean => {
    const action = suggestKeyAction(e, { open, moved, enter, tab });
    const pick = matches[active];
    if (action === "none" || (action === "accept" && !pick)) return false;
    e.preventDefault();
    if (action === "down" || action === "up") {
      setMoved(true);
      setActive((a) => (action === "down" ? Math.min(a + 1, matches.length - 1) : Math.max(a - 1, 0)));
    } else if (action === "accept") {
      onPick(pick);
      reset();
    } else {
      // Closing the list is this Escape's whole job.
      e.stopPropagation();
      onClose?.();
    }
    return true;
  };

  return {
    active,
    setActive,
    onKeyDown,
    reset,
    ariaProps: {
      role: "combobox",
      "aria-haspopup": "listbox",
      "aria-expanded": open,
      "aria-autocomplete": "list",
    } as const,
  };
}
