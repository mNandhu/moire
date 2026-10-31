import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

type Ref = RefObject<HTMLElement | null>;

/**
 * Closes an open popover on a press outside it or on Escape. `refs` are the
 * regions that count as inside (the popover and its trigger when they are not
 * one element). Mouse and touch both count; `onClose` is read through a ref, so
 * it may be a fresh closure each render.
 *
 * Escape is listened for on the document and skipped when something already
 * handled it (`defaultPrevented`). A Dialog stops keys at its backdrop, so a
 * popover inside one never sees them there: put the returned `onKeyDown` on the
 * popover's wrapper element. It claims the Escape (`preventDefault`), so the
 * Dialog leaves it to the popover.
 *
 * `escape: false` leaves Escape to the caller (a Picker or DropdownMenu that
 * owns its keys) and handles only the outside press.
 */
export function useDismiss(
  refs: Ref | Ref[],
  onClose: () => void,
  open: boolean,
  { escape = true }: { escape?: boolean } = {},
) {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const list = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      if (list.some((r) => r.current?.contains(target))) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    if (escape) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      if (escape) document.removeEventListener("keydown", onKey);
    };
  }, [open, escape]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!escape || !open || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    },
    [escape, open],
  );
  return { onKeyDown };
}
