/**
 * Every keyboard shortcut, declared once: the keys a handler matches and the
 * row the `?` reference shows for them. Handlers bind a spec (`useHotkeys([
 * { ...<spec>, run }])`, or `spec.keys.includes(e.key)` in an element's
 * own onKeyDown), and the reference is built from the same specs, so a key
 * can't change in one place and not the other. A new shortcut gets a spec in
 * its page's group; shortcuts.test.ts checks every spec is bound somewhere.
 * Keys meant to stay out of the reference (Space scrolling, Escape backing
 * out of a focused tile) are bound without a spec.
 * Pure.
 */

import { SEARCH_KEYS, WEIGHT_KEYS } from "./platform";

export type ShortcutPage = "everywhere" | "gallery" | "image" | "generate" | "generations";

/** One row of the reference. `keys` are the `e.key` values that trigger it;
 * absent when the handler needs its own match (named on the spec). `label` is
 * how the row writes them, which can be shorter than `keys` (`+ / -` also
 * takes `=` and `_`). */
export type ShortcutSpec = { keys?: readonly string[]; label: string; desc: string };

export type ShortcutGroup = {
  title: string;
  page: ShortcutPage;
  keys: [string, string][];
};

const DIGITS_0_5: readonly string[] = ["0", "1", "2", "3", "4", "5"];
const QUARANTINE_KEYS: readonly string[] = ["x", "X", "Delete"];
const ZOOM_IN_KEYS: readonly string[] = ["+", "="];
const ZOOM_OUT_KEYS: readonly string[] = ["-", "_"];
const PREV_IMAGE_KEYS: readonly string[] = ["ArrowLeft"];
const NEXT_IMAGE_KEYS: readonly string[] = ["ArrowRight"];

export const EVERYWHERE = {
  // Matched by App's layout-aware Ctrl/Cmd+K test.
  search: { label: SEARCH_KEYS, desc: "Search everything" },
  help: { keys: ["?"], label: "?", desc: "This help" },
  // Dialogs and popovers close on it themselves (Dialog, useDismiss); the
  // app-level panels (mobile drawer, Tags page detail) bind this spec.
  close: { keys: ["Escape"], label: "Esc", desc: "Close what's open" },
} satisfies Record<string, ShortcutSpec>;

export const GALLERY = {
  move: { keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], label: "← → ↑ ↓", desc: "Move between tiles" },
  open: { keys: ["Enter"], label: "Enter", desc: "Open the focused image" },
  // The shell scroller (useShellKeyScroll) binds these on every page.
  scrollPage: { keys: ["PageUp", "PageDown"], label: "PgUp / PgDn", desc: "Scroll a page" },
  scrollEnds: { keys: ["Home", "End"], label: "Home / End", desc: "Jump to start or end" },
  search: { keys: ["/", "f", "F"], label: "/ or F", desc: "Focus the tag search" },
  zoom: { keys: [...ZOOM_IN_KEYS, ...ZOOM_OUT_KEYS], label: "+ / -", desc: "Larger / smaller thumbnails" },
} satisfies Record<string, ShortcutSpec>;

/** Whether a zoom key zooms in (the rest zoom out). */
export const isZoomIn = (key: string) => ZOOM_IN_KEYS.includes(key);

export const TRIAGE = {
  score: { keys: DIGITS_0_5, label: "0 – 5", desc: "Score the focused image" },
  quarantine: { keys: QUARANTINE_KEYS, label: "X / Del", desc: "Quarantine (or restore) it" },
} satisfies Record<string, ShortcutSpec>;

export const FILTER = {
  noTags: { keys: ["n", "N"], label: "N", desc: "Untagged images" },
  noAiTags: { keys: ["a", "A"], label: "A", desc: "Images with no AI tags" },
  quarantined: { keys: ["q", "Q"], label: "Q", desc: "Quarantined images" },
  selection: { keys: ["s", "S"], label: "S", desc: "Selection mode" },
} satisfies Record<string, ShortcutSpec>;

export const IMAGE = {
  step: { keys: [...PREV_IMAGE_KEYS, ...NEXT_IMAGE_KEYS], label: "← →", desc: "Previous / next image" },
  score: { keys: DIGITS_0_5, label: "0 – 5", desc: "Score it" },
  quarantine: { keys: QUARANTINE_KEYS, label: "X / Del", desc: "Quarantine (or restore) it" },
  back: { keys: ["Escape"], label: "Esc", desc: "Back to the gallery" },
} satisfies Record<string, ShortcutSpec>;

/** Whether a step key goes back (the rest go forward). */
export const isPrevImage = (key: string) => PREV_IMAGE_KEYS.includes(key);

export const GENERATE = {
  // With Ctrl/Cmd, in PromptInput.
  weight: { keys: ["ArrowUp", "ArrowDown"], label: WEIGHT_KEYS, desc: "Raise / lower the weight of the term at the cursor" },
  // Taken by the shared suggestion-list keys (tagSuggest suggestKeyAction).
  suggest: { keys: ["Tab"], label: "Tab", desc: "Take the suggested tag" },
} satisfies Record<string, ShortcutSpec>;

export const BATCH = {
  score: { keys: ["1", "2", "3", "4", "5"], label: "1 – 5", desc: "Score the focused image" },
  reject: { keys: ["x", "X"], label: "X", desc: "Reject it" },
  keep: { keys: ["k", "K"], label: "K", desc: "Keep it" },
} satisfies Record<string, ShortcutSpec>;

/** Each group of the reference, in the order it reads, with its specs. */
export const SHORTCUT_SPECS: { title: string; page: ShortcutPage; name: string; specs: Record<string, ShortcutSpec> }[] = [
  { title: "Everywhere", page: "everywhere", name: "EVERYWHERE", specs: EVERYWHERE },
  { title: "Gallery", page: "gallery", name: "GALLERY", specs: GALLERY },
  { title: "Triage", page: "gallery", name: "TRIAGE", specs: TRIAGE },
  { title: "Filter and select", page: "gallery", name: "FILTER", specs: FILTER },
  { title: "Image", page: "image", name: "IMAGE", specs: IMAGE },
  { title: "Generate", page: "generate", name: "GENERATE", specs: GENERATE },
  { title: "Batch results", page: "generations", name: "BATCH", specs: BATCH },
];

const SHORTCUT_GROUPS: ShortcutGroup[] = SHORTCUT_SPECS.map(({ title, page, specs }) => ({
  title,
  page,
  keys: Object.values(specs).map((s): [string, string] => [s.label, s.desc]),
}));

/** Which page's shortcuts apply at `pathname`. */
export function shortcutPage(pathname: string): ShortcutPage {
  if (pathname === "/") return "gallery";
  if (pathname.startsWith("/image/")) return "image";
  if (pathname === "/generate") return "generate";
  if (pathname.startsWith("/generations/")) return "generations";
  return "everywhere";
}

/** The groups to show at `pathname`: this page's first, then everywhere's,
 * then the rest. */
export function shortcutGroups(pathname: string): ShortcutGroup[] {
  const here = shortcutPage(pathname);
  const rank = (g: ShortcutGroup) => (g.page === here ? 0 : g.page === "everywhere" ? 1 : 2);
  return [...SHORTCUT_GROUPS].sort((a, b) => rank(a) - rank(b));
}

/** Opens the help from a button (the `?` key opens it by itself). */
export const OPEN_SHORTCUTS_EVENT = "moire:shortcuts";
export function openShortcutHelp() {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT));
}
