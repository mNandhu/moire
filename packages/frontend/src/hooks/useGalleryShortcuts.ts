import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useToast } from "../components/Toasts";
import type { Filters } from "../lib/imageFilter";
import { readLocalPref, writeLocalPref } from "../lib/localPref";
import { SHORTCUT_HINT_KEY } from "../lib/onboarding";
import type { useDensity } from "./useDensity";
import { useHotkeys } from "./useHotkeys";

/**
 * The gallery's page-wide shortcuts: S selection mode, F/"/" focus search,
 * N no-tags, A no-AI-tags, Q quarantined, +/- zoom, Escape backs out (? help
 * is global: ShortcutHelp). Also says where the shortcuts are, once, right
 * after first-run setup.
 */
export function useGalleryShortcuts({
  filters,
  setFilters,
  density,
  searchInputRef,
  selectionMode,
  setSelectionMode,
  setFocusedIndex,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  density: ReturnType<typeof useDensity>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  selectionMode: boolean;
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
}) {
  const { push } = useToast();

  // Once, right after first-run setup: say where the shortcuts are.
  useEffect(() => {
    if (readLocalPref(SHORTCUT_HINT_KEY) !== "1") return;
    writeLocalPref(SHORTCUT_HINT_KEY, null);
    push("Press ? to see keyboard shortcuts", { type: "info", durationMs: 8000 });
  }, [push]);

  // Global shortcuts: S selection mode, F/"/" focus search, N no-tags,
  // A no-AI-tags, Q quarantined, +/- zoom (? help is global: ShortcutHelp).
  useHotkeys([
    {
      keys: ["+", "="],
      run: (e) => {
        e.preventDefault();
        density.zoomIn();
      },
    },
    {
      keys: ["-", "_"],
      run: (e) => {
        e.preventDefault();
        density.zoomOut();
      },
    },
    {
      keys: ["/", "f", "F"],
      run: (e) => {
        e.preventDefault();
        searchInputRef.current?.focus();
      },
    },
    {
      // One key backs out of whatever is engaged, outermost first. The
      // overlay is handled above, before the bail.
      keys: ["Escape"],
      run: () => {
        if (selectionMode) setSelectionMode(false);
        else setFocusedIndex(-1);
      },
    },
    {
      keys: ["s", "S"],
      run: (e) => {
        e.preventDefault();
        setSelectionMode((v) => {
          const next = !v;
          push(next ? "Selection mode ON" : "Selection mode OFF", "info");
          return next;
        });
      },
    },
    {
      keys: ["n", "N"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.noTags;
        push(next ? "No-tags filter ON" : "No-tags filter OFF", "info");
        setFilters({ ...filters, noTags: next });
      },
    },
    {
      keys: ["a", "A"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.noAiTags;
        push(next ? "No-AI-tags filter ON" : "No-AI-tags filter OFF", "info");
        setFilters({ ...filters, noAiTags: next });
      },
    },
    {
      keys: ["q", "Q"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.quarantined;
        push(next ? "Showing quarantined" : "Showing active feed", "info");
        setFilters({ ...filters, quarantined: next });
      },
    },
  ]);
}
