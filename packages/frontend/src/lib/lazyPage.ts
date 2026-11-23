import { lazy, type ComponentType } from "react";

// A tab opened before a rebuild asks for chunks the build deleted: reload
// once for the new ones rather than show an error page.
const RELOADED_KEY = "moire.chunk-reload";
export function lazyPage<T extends ComponentType>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(RELOADED_KEY);
        } catch {
          // Storage refused: nothing to clear.
        }
        return m;
      },
      (e) => {
        // Offline, the chunk may well exist: show the error, keep the tab.
        let reloaded = !navigator.onLine;
        try {
          reloaded ||= sessionStorage.getItem(RELOADED_KEY) === "1";
          if (!reloaded) sessionStorage.setItem(RELOADED_KEY, "1");
        } catch {
          // Without storage a reload could loop; show the error instead.
        }
        if (!reloaded) {
          window.location.reload();
          return new Promise<never>(() => {});
        }
        throw e;
      },
    ),
  );
}
