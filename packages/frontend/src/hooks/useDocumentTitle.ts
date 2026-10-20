import { useEffect } from "react";

export const APP_NAME = "Moiré";

// Put before whatever the page titles the tab (time left on the generation
// queue); kept apart so pages and the prefix don't overwrite each other.
let prefix = "";
const strip = (t: string) => (prefix && t.startsWith(prefix) ? t.slice(prefix.length) : t);

/** Show `next` before the page's title ("2m left · Generate · Moiré"); "" removes it. */
export function setTitlePrefix(next: string) {
  if (next === prefix) return;
  const base = strip(document.title);
  prefix = next;
  document.title = prefix + base;
}

/**
 * Name the browser tab (and its history entry) after what's on screen:
 * "All Images · Moiré". The previous title comes back on unmount, so closing
 * the image view over the gallery returns the tab to the gallery's title.
 */
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    if (!title) return;
    const prev = strip(document.title);
    document.title = `${prefix}${title} · ${APP_NAME}`;
    return () => {
      document.title = prefix + prev;
    };
  }, [title]);
}
