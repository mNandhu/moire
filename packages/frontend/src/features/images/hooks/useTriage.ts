import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/Toasts";
import { errorText } from "@/lib/api";
import { patchFeeds, writeImageFields } from "@/features/images/lib/feedCache";
import { nextFocusIndex, type GridNavKey } from "@/features/images/lib/gridNav";
import { GALLERY, TRIAGE } from "@/lib/shortcuts";
import type { FeedItem } from "@/features/images/lib/imageFilter";
import { setScore as apiSetScore, setQuarantine as apiSetQuarantine } from "@/features/images/lib/imageMutations";
import { useHotkeys } from "@/hooks/useHotkeys";
import { useOverlayOpen } from "@/lib/backgroundLocation";

/**
 * Keyboard triage on the gallery's tiles: arrows move the focus, 0-5 score,
 * X/Delete quarantines (or restores, in the quarantined view) and Enter opens
 * the focused tile. Score and quarantine act on the focused tile or, when the
 * mouse moved since the last arrow key, on the tile under the pointer, so
 * triage needs no image view and no arrowing to a tile first. Only one of the
 * two is ever live: moving the mouse clears the focus ring (so it never marks
 * a tile the keys no longer act on), and an arrow key takes over again from
 * the hovered tile. The page owns `focusedIndex` (-1 = none); this keeps it in
 * range, clears it while triage is off and scrolls the focused tile into view.
 */
export function useTriage({
  items,
  focusedIndex,
  setFocusedIndex,
  enabled,
  quarantined,
  gridColsRef,
  getScrollContainer,
  openTile,
  refetchFeed,
}: {
  items: FeedItem[];
  focusedIndex: number;
  setFocusedIndex: Dispatch<SetStateAction<number>>;
  enabled: boolean;
  /** The quarantined view: X restores instead. */
  quarantined: boolean;
  /** The column count the grid packed (VirtualizedGrid's `onColumns`). */
  gridColsRef: { readonly current: number };
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
    (mut: (pages: FeedItem[][]) => FeedItem[][]) => patchFeeds(queryClient, mut),
    [queryClient],
  );

  // Where the mouse pointer last was, and whether it moved after the last
  // arrow key. The tile under it is looked up at keypress (hoveredItem), not
  // stored on pointerover: a wheel scroll or a quarantined tile dropping out
  // moves tiles under a resting pointer without a new pointer event.
  const pointer = useRef({ x: NaN, y: NaN, live: false });
  const focusedRef = useRef(focusedIndex);
  focusedRef.current = focusedIndex;
  // An image open over the gallery owns the pointer: moves made in it must
  // not aim the keys at the tile beneath once it closes.
  const overlayOpen = useOverlayOpen();
  const tracking = enabled && !overlayOpen;
  useEffect(() => {
    if (!tracking) return;
    const p = pointer.current;
    const onMove = (e: PointerEvent) => {
      // A tap is no hover: it leaves no pointer resting over a tile.
      if (e.pointerType === "touch") return;
      // Only a real move: a browser may send one for content scrolled under a
      // resting pointer (an arrow key's scroll), which must not take over.
      if (e.clientX === p.x && e.clientY === p.y) return;
      p.x = e.clientX;
      p.y = e.clientY;
      p.live = true;
      if (focusedRef.current >= 0) setFocusedIndex(-1);
    };
    const onOut = (e: PointerEvent) => {
      if (!e.relatedTarget) p.live = false; // left the window
    };
    const onBlur = () => {
      p.live = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerout", onOut);
    window.addEventListener("blur", onBlur);
    return () => {
      p.live = false;
      p.x = p.y = NaN;
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerout", onOut);
      window.removeEventListener("blur", onBlur);
    };
  }, [tracking, setFocusedIndex]);

  /** The tile under the pointer, if the pointer is the latest input. Anything
   * drawn over the grid (a menu, a dialog) hides the tile beneath it. */
  const hoveredItem = useCallback((): FeedItem | undefined => {
    const p = pointer.current;
    if (!p.live) return undefined;
    const tile = document.elementFromPoint(p.x, p.y)?.closest("[data-tile-id]");
    const id = tile?.getAttribute("data-tile-id");
    return id ? items.find((x) => x._id === id) : undefined;
  }, [items]);

  /** The tile a score or quarantine key acts on: hovered, else focused. */
  const triageTarget = useCallback(
    (): FeedItem | undefined => hoveredItem() ?? (focusedIndex >= 0 ? items[focusedIndex] : undefined),
    [hoveredItem, items, focusedIndex],
  );

  // Images whose quarantine write is in flight: a repeated X (key repeat, or
  // pressed again before the feed re-renders) must not send it twice.
  const pending = useRef(new Set<string>());

  const triageScore = useCallback(
    async (it: FeedItem, n: number) => {
      // Every cached copy, the open-image document included, so ImageView
      // shows the new score too; undone if the write fails.
      try {
        await writeImageFields(queryClient, it._id, { score: n }, () => apiSetScore(it._id, n));
      } catch (e) {
        push(`Failed to set score: ${errorText(e)}`, "error");
      }
    },
    [queryClient, push],
  );

  const triageQuarantine = useCallback(
    async (it: FeedItem) => {
      // Default feed quarantines; the quarantined view restores. Either way the
      // tile leaves the current list, so drop it and keep the focus on the
      // same image (or, if it was the one dropped, in range).
      const next = !quarantined;
      const removed = items.findIndex((x) => x._id === it._id);
      if (removed < 0 || pending.current.has(it._id)) return;
      pending.current.add(it._id);
      patchFeed((pages) => pages.map((pg) => pg.filter((x) => x._id !== it._id)));
      setFocusedIndex((i) => (i < 0 ? i : i > removed ? i - 1 : Math.min(i, items.length - 2)));
      try {
        await apiSetQuarantine(it._id, next);
        // Named, since a hovered tile has no focus ring to say which it was.
        const name = it.path.split(/[\\/]/).pop();
        push(`${next ? "Quarantined" : "Restored"}${name ? ` ${name}` : ""}`, "info");
      } catch (e) {
        push(`Failed: ${errorText(e)}`, "error");
        refetchFeed();
      } finally {
        pending.current.delete(it._id);
      }
    },
    [items, quarantined, patchFeed, push, refetchFeed, setFocusedIndex],
  );

  useEffect(() => {
    if (!enabled) setFocusedIndex(-1);
  }, [enabled, setFocusedIndex]);

  useHotkeys(
    [
      {
        ...GALLERY.move,
        run: (e) => {
          e.preventDefault();
          // The keys take over from the pointer until it moves again, starting
          // on the tile it points at rather than back at the first one.
          const hovered = hoveredItem();
          pointer.current.live = false;
          if (hovered) {
            setFocusedIndex(items.indexOf(hovered));
            return;
          }
          const key = e.key as GridNavKey;
          const cols = gridColsRef.current;
          setFocusedIndex((prev) => nextFocusIndex(prev, key, cols, items.length));
        },
      },
      {
        ...TRIAGE.score,
        run: (e) => {
          const it = triageTarget();
          if (!it) return;
          e.preventDefault();
          void triageScore(it, Number(e.key));
        },
      },
      {
        ...TRIAGE.quarantine,
        run: (e) => {
          const it = triageTarget();
          if (!it) return;
          e.preventDefault();
          void triageQuarantine(it);
        },
      },
      {
        // The tile that receives focus is ThumbnailTile's wrapper <div
        // tabIndex={-1}>, not the inner <button>, so there is no default
        // activation to fall back on, arrowing to a tile and pressing Enter
        // did nothing at all.
        ...GALLERY.open,
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
