import type { RefObject } from "react";
import { useHotkeys } from "./useHotkeys";
import { scrollDeltaForKey } from "../lib/dom";
import { GALLERY } from "../lib/shortcuts";

/**
 * Keyboard scrolling (PageDown/PageUp/Home/End/Space/arrows) for the app's
 * main scroll container. The app scrolls inside an overflow div, so default
 * PageDown on window does nothing. ImageView is mounted on top of the
 * gallery, not routed in place of it, so its own key handling would
 * otherwise fire alongside this one and scroll the hidden gallery underneath
 * (useHotkeys bails while an overlay is open).
 */
export function useShellKeyScroll(scrollRef: RefObject<HTMLElement | null>) {
  const scroll = (e: KeyboardEvent) => {
    const scroller = scrollRef.current;
    const delta = scrollDeltaForKey(e, scroller?.clientHeight ?? 0);
    if (delta === null) return;
    e.preventDefault();
    if (delta === "top") scroller?.scrollTo({ top: 0, behavior: "auto" });
    else if (delta === "bottom") scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
    else scroller?.scrollBy({ top: delta, behavior: "auto" });
  };
  useHotkeys([
    { ...GALLERY.scrollPage, run: scroll },
    // Ctrl/Cmd+Home/End mean top/bottom too; other combos stay the browser's.
    { ...GALLERY.scrollEnds, mods: "ctrl", run: scroll },
    {
      keys: [" ", "Spacebar"],
      run: (e) => {
        // Space scrolls down, Shift+Space up; a focused button keeps Space
        // (it activates it).
        const active = document.activeElement as HTMLElement | null;
        if (active && active.tagName?.toLowerCase() === "button") return;
        scroll(e);
      },
    },
    // Arrows only while the body has focus, so keyboard navigation in
    // interactive controls is left alone.
    {
      keys: ["ArrowDown", "ArrowUp"],
      run: (e) => {
        if (document.activeElement === document.body) scroll(e);
      },
    },
  ]);
}
