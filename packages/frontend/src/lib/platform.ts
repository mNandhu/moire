/** Platform detection and the key names this keyboard writes. Pure. */

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The command modifier as its key cap reads. */
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/** The search's shortcut as this keyboard writes it. */
export const SEARCH_KEYS = IS_MAC ? "⌘K" : "Ctrl K";

/** The search's shortcut for `aria-keyshortcuts`. */
export const SEARCH_ARIA_KEYS = IS_MAC ? "Meta+K" : "Control+K";
