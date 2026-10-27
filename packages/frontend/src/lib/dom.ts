/**
 * Whether an event target is a text-entry control, so global keyboard shortcuts
 * can bow out while the user is typing. Was copy-pasted in three keydown
 * handlers (ImageView + two in AllImagesPage); this is the one copy.
 */
export function isFormField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    el.isContentEditable === true
  );
}

/**
 * Whether a keydown carries Ctrl, Cmd or Alt, so a bare-key shortcut can leave
 * it to the browser (Ctrl+1 switches tab, Alt+Left goes back, Ctrl+X cuts).
 */
export function hasModifier(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}

/**
 * The nearest ancestor of `el` that scrolls vertically (overflow-y auto or
 * scroll), or null when the page itself is the scroller.
 */
export function scrollParent(el: Element | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** How far a key scrolls a scroller `clientHeight` tall: a pixel delta, or
 * "top"/"bottom". Null for a key this doesn't scroll by. Modifier rules are
 * the caller's (its hotkey bindings). */
export function scrollDeltaForKey(
  e: { key: string; shiftKey: boolean },
  clientHeight: number,
): number | "top" | "bottom" | null {
  const page = Math.max(120, Math.floor(clientHeight * 0.9));
  switch (e.key) {
    case "PageDown":
      return page;
    case "PageUp":
      return -page;
    case " ":
    case "Spacebar":
      return e.shiftKey ? -page : page;
    case "ArrowDown":
      return 48;
    case "ArrowUp":
      return -48;
    case "Home":
      return "top";
    case "End":
      return "bottom";
    default:
      return null;
  }
}
