/** Platform detection and the key names this keyboard writes. Pure. */

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The search's shortcut as this keyboard writes it. */
export const SEARCH_KEYS = IS_MAC ? "⌘K" : "Ctrl K";

/** The prompt weight keys as this keyboard writes them. */
export const WEIGHT_KEYS = IS_MAC ? "⌘ ↑ / ↓" : "Ctrl + ↑ / ↓";

/** The search's shortcut for `aria-keyshortcuts`. */
export const SEARCH_ARIA_KEYS = IS_MAC ? "Meta+K" : "Control+K";
