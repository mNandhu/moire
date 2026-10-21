import { useLayoutEffect, type RefObject } from "react";
import { nudgeIntoView } from "../lib/viewportFit";

/**
 * Keeps an open popover on screen. Anchoring classes (`right-0`, a card's
 * side flyout) place it; on a phone that spot can sit off an edge, so this
 * shifts it back with `translate`. Measured after every render while open
 * (a filtered list changes height) and again on resize and scroll.
 */
export function useKeepInViewport(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const fit = () => {
      el.style.translate = "";
      const { x, y } = nudgeIntoView(el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
      if (x || y) el.style.translate = `${x}px ${y}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  });
}
