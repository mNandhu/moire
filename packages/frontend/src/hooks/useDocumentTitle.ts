import { useEffect } from "react";

export const APP_NAME = "Moiré";

/**
 * Name the browser tab (and its history entry) after what's on screen:
 * "All Images · Moiré". The previous title comes back on unmount, so closing
 * the image view over the gallery returns the tab to the gallery's title.
 */
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title} · ${APP_NAME}`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
