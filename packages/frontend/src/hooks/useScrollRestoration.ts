import { useCallback, useEffect, useRef } from "react";

// Slim scroll restoration for the gallery's custom overflow container.
// The fetch-until-itemCount dance the old util needed is gone: the Image feed
// query cache persists fetched pages across gallery -> ImageView -> gallery, so
// the rows are already mounted on return and we only need to restore scrollTop.

const PREFIX = "moire_scroll_";
const MAX_AGE_MS = 10 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 200;

type Saved = { scrollTop: number; ts: number };

/** A position waiting to be applied, and the storage key it came from. */
export type PendingRestore = { key: string; top: number };

function readSaved(storageKey: string): PendingRestore | null {
  let saved: Saved | null;
  try {
    const raw = sessionStorage.getItem(storageKey);
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  if (!saved || Date.now() - saved.ts > MAX_AGE_MS) return null;
  if (!(saved.scrollTop > 0)) return null;
  return { key: storageKey, top: saved.scrollTop };
}

/**
 * Persist the scroll position of `getContainer()` keyed by `key` (derive it
 * from the active Image filter), and hand back the position to restore.
 *
 * Restoration is *not* performed here. Coming back from ImageView remounts the
 * page, so the scroll container is a brand-new node at scrollTop 0 and the
 * grid it contains has no height until it has measured itself. This hook used
 * to scroll on a 100ms `setTimeout`, which meant the browser reliably painted
 * the top of the gallery first and jumped a beat later — the "snap" was the
 * restoration itself, not a layout settling. So the offset is returned and the
 * grid applies it in a layout effect, in the same pre-paint commit where it
 * first has a real height to scroll within.
 */
export function useScrollRestoration(
  key: string,
  getContainer: () => HTMLElement | null,
) {
  const storageKey = PREFIX + (key || "default");

  // Flush the current position immediately (e.g. just before navigating away,
  // where a pending debounced save would be cancelled by unmount).
  const save = useCallback(() => {
    const el = getContainer();
    if (!el) return;
    try {
      const saved: Saved = { scrollTop: el.scrollTop, ts: Date.now() };
      sessionStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      // ignore quota / private-mode errors
    }
  }, [storageKey, getContainer]);

  // Save on scroll (debounced).
  useEffect(() => {
    const el = getContainer();
    if (!el) return;
    let timer: number | undefined;
    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          const saved: Saved = { scrollTop: el.scrollTop, ts: Date.now() };
          sessionStorage.setItem(storageKey, JSON.stringify(saved));
        } catch {
          // ignore quota / private-mode errors
        }
      }, SAVE_DEBOUNCE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, [storageKey, getContainer]);

  // The stored offset, read once per key. Read during render rather than in an
  // effect so the value is available to the grid's first layout pass; re-read
  // only when the key changes, so it isn't clobbered by our own debounced
  // saves as the user scrolls.
  const readKeyRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingRestore | null>(null);
  if (readKeyRef.current !== storageKey) {
    readKeyRef.current = storageKey;
    pendingRef.current = readSaved(storageKey);
  }

  return { save, restore: pendingRef.current };
}
