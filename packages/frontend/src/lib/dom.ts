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
