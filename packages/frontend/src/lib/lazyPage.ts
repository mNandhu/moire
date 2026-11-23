import { createElement, lazy, useState, type ComponentType } from "react";

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

// A failed load is retried only by a mount this long after it: React renders
// a page again as soon as its load rejects (the state of a first render that
// suspended is thrown away, so no mount can keep its own loader), and that
// render must reach the error boundary, not fetch again and again.
const RETRY_AFTER_MS = 500;

/** A {@link lazyPage} whose code can be fetched ahead (`preload`): once it
 * has arrived, a page mounted after renders at once instead of suspending
 * for a frame. A failed load is forgotten, preload's and the render's alike:
 * a later mount tries again (React.lazy keeps its first failure, so a fresh
 * one replaces it). */
export function preloadablePage<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  let ready: ComponentType<P> | undefined;
  let pending: Promise<{ default: ComponentType<P> }> | undefined;
  let failedAt = 0;
  const preload = () =>
    (pending ??= load().then(
      (m) => {
        ready = m.default;
        return m;
      },
      (e) => {
        pending = undefined;
        failedAt = Date.now();
        throw e;
      },
    ));
  // lazyPage is typed for pages without props; the props pass through as-is.
  const lazyOf = () => lazyPage(preload as () => Promise<{ default: ComponentType }>) as unknown as ComponentType<P>;
  let Lazy = lazyOf();
  function Page(props: P) {
    // Picked once per mount: switching from Lazy to the loaded component
    // would remount the page.
    const [Shown] = useState(() => {
      if (ready) return ready;
      if (failedAt && Date.now() - failedAt >= RETRY_AFTER_MS) {
        failedAt = 0;
        Lazy = lazyOf();
      }
      return Lazy;
    });
    return createElement(Shown, props);
  }
  return { Page, preload };
}
