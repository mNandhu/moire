import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/Toasts";
import { errorText } from "../lib/api";
import { patchFeeds, writeImageFields } from "../lib/feedCache";
import { nextFocusIndex, isGridNavKey, type GridNavKey } from "../lib/gridNav";
import type { ImageDoc } from "../lib/imageFilter";
import { setScore as apiSetScore, setQuarantine as apiSetQuarantine } from "../lib/imageMutations";
import { gridColumns } from "../lib/masonryLayout";
import { useHotkeys } from "./useHotkeys";

/**
 * Keyboard triage on the gallery's focused tile: arrows move the focus, 0-5
 * score it, X/Delete quarantines (or restores, in the quarantined view) and
 * Enter opens it. The page owns `focusedIndex` (-1 = none); this keeps it in
 * range, clears it while triage is off and scrolls the focused tile into view.
 */
export function useTriage({
  items,
  focusedIndex,
  setFocusedIndex,
  enabled,
  quarantined,
  density,
  gridWrapRef,
  getScrollContainer,
  openTile,
  refetchFeed,
}: {
  items: ImageDoc[];
  focusedIndex: number;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  enabled: boolean;
  /** The quarantined view: X restores instead. */
  quarantined: boolean;
  density: number;
  gridWrapRef: RefObject<HTMLDivElement | null>;
  getScrollContainer: () => HTMLElement | null;
  openTile: (id: string) => void;
  refetchFeed: () => void;
}) {
  const { push } = useToast();
  const queryClient = useQueryClient();

  // Optimistically patch the feed cache so a score/quarantine shows instantly.
  // Patches every cached feed, not just the current filter; the same image can
  // be cached under several.
  const patchFeed = useCallback(
    (mut: (pages: ImageDoc[][]) => ImageDoc[][]) => patchFeeds(queryClient, mut),
    [queryClient],
  );

  const triageScore = useCallback(
    async (n: number) => {
      const it = items[focusedIndex];
      if (!it) return;
      // Every cached copy, the open-image document included, so ImageView
      // shows the new score too; undone if the write fails.
      try {
        await writeImageFields(queryClient, it._id, { score: n }, () => apiSetScore(it._id, n));
      } catch (e) {
        push(`Failed to set score: ${errorText(e)}`, "error");
      }
    },
    [items, focusedIndex, queryClient, push],
  );

  const triageQuarantine = useCallback(async () => {
    const it = items[focusedIndex];
    if (!it) return;
    // Default feed quarantines; the quarantined view restores. Either way the
    // tile leaves the current list, so drop it and keep focus in range.
    const next = !quarantined;
    patchFeed((pages) => pages.map((pg) => pg.filter((x) => x._id !== it._id)));
    setFocusedIndex((i) => Math.min(i, items.length - 2));
    try {
      await apiSetQuarantine(it._id, next);
      push(next ? "Quarantined" : "Restored", "info");
    } catch (e) {
      push(`Failed: ${errorText(e)}`, "error");
      refetchFeed();
    }
  }, [items, focusedIndex, quarantined, patchFeed, push, refetchFeed, setFocusedIndex]);

  useEffect(() => {
    if (!enabled) setFocusedIndex(-1);
  }, [enabled, setFocusedIndex]);

  useHotkeys(
    [
      {
        match: (e) => isGridNavKey(e.key),
        run: (e) => {
          e.preventDefault();
          const key = e.key as GridNavKey;
          const cols = gridColumns(gridWrapRef.current?.clientWidth || 0, density);
          setFocusedIndex((prev) => nextFocusIndex(prev, key, cols, items.length));
        },
      },
      {
        match: (e) => e.key >= "0" && e.key <= "5",
        run: (e) => {
          if (focusedIndex < 0) return;
          e.preventDefault();
          void triageScore(Number(e.key));
        },
      },
      {
        keys: ["x", "X", "Delete"],
        run: (e) => {
          if (focusedIndex < 0) return;
          e.preventDefault();
          void triageQuarantine();
        },
      },
      {
        // The tile that receives focus is ThumbnailTile's wrapper <div
        // tabIndex={-1}>, not the inner <button>, so there is no default
        // activation to fall back on, arrowing to a tile and pressing Enter
        // did nothing at all.
        keys: ["Enter"],
        run: (e) => {
          const it = focusedIndex >= 0 ? items[focusedIndex] : undefined;
          if (!it) return;
          e.preventDefault();
          openTile(it._id);
        },
      },
    ],
    { enabled },
  );

  useEffect(() => {
    if (focusedIndex < 0) return;
    const sc = getScrollContainer();
    const focusEl = () => {
      const el = sc?.querySelector(
        `[data-tile-index="${focusedIndex}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.focus?.({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      }
      return !!el;
    };
    if (!focusEl()) {
      const id = setTimeout(focusEl, 80);
      return () => clearTimeout(id);
    }
  }, [focusedIndex, getScrollContainer]);
}
