import { useEffect, useLayoutEffect, type RefObject } from "react";
import { nudgeIntoView } from "../lib/viewportFit";

/** The area a popover can actually be seen in: no scrollbar, no on-screen
 * keyboard. */
function visibleSize() {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function fit(el: HTMLElement) {
  el.style.translate = "";
  const { width, height } = visibleSize();
  const { x, y } = nudgeIntoView(el.getBoundingClientRect(), width, height);
  if (x || y) el.style.translate = `${x}px ${y}px`;
}

/**
 * Keeps an open popover on screen. Anchoring classes (`right-0`, a card's
 * side flyout) place it; on a phone that spot can sit off an edge, so this
 * shifts it back with `translate`. Measured after every render while open
 * (a filtered list changes height) and when the viewport resizes. Not on
 * scroll: a menu follows its trigger, it doesn't chase the screen edge.
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    if (open && ref.current) fit(ref.current);
  });
  useEffect(() => {
    if (!open) return;
    const refit = () => ref.current && fit(ref.current);
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, [open, ref]);
}
