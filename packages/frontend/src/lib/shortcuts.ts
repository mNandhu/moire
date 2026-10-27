/**
 * The keyboard reference that `?` opens anywhere: each group of keys and the
 * page it works on. A new shortcut gets a row here, next to its page's others.
 * Pure.
 */

import { SEARCH_KEYS } from "./platform";

export type ShortcutPage = "everywhere" | "gallery" | "image" | "generations";

export type ShortcutGroup = {
  title: string;
  page: ShortcutPage;
  keys: [string, string][];
};


const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Everywhere",
    page: "everywhere",
    keys: [
      [SEARCH_KEYS, "Search everything"],
      ["?", "This help"],
      ["Esc", "Close what's open"],
    ],
  },
  {
    title: "Gallery",
    page: "gallery",
    keys: [
      ["← → ↑ ↓", "Move between tiles"],
      ["Enter", "Open the focused image"],
      ["PgUp / PgDn", "Scroll a page"],
      ["Home / End", "Jump to start or end"],
      ["/ or F", "Focus the tag search"],
      ["+ / -", "Larger / smaller thumbnails"],
    ],
  },
  {
    title: "Triage",
    page: "gallery",
    keys: [
      ["0 – 5", "Score the focused image"],
      ["X / Del", "Quarantine (or restore) it"],
    ],
  },
  {
    title: "Filter and select",
    page: "gallery",
    keys: [
      ["N", "Untagged images"],
      ["A", "Images with no AI tags"],
      ["Q", "Quarantined images"],
      ["S", "Selection mode"],
    ],
  },
  {
    title: "Image",
    page: "image",
    keys: [
      ["← →", "Previous / next image"],
      ["0 – 5", "Score it"],
      ["X / Del", "Quarantine (or restore) it"],
      ["Esc", "Back to the gallery"],
    ],
  },
  {
    title: "Batch results",
    page: "generations",
    keys: [
      ["1 – 5", "Score the focused image"],
      ["X", "Reject it"],
      ["K", "Keep it"],
    ],
  },
];

/** Which page's shortcuts apply at `pathname`. */
export function shortcutPage(pathname: string): ShortcutPage {
  if (pathname === "/") return "gallery";
  if (pathname.startsWith("/image/")) return "image";
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
