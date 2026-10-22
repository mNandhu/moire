import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Whether a media query matches, live. False where matchMedia is missing. */
export function useMediaQuery(query: string): boolean {
  // One list per query: read on every render, so not rebuilt each time.
  const mq = useMemo(() => window.matchMedia?.(query), [query]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      mq?.addEventListener("change", onChange);
      return () => mq?.removeEventListener("change", onChange);
    },
    [mq],
  );
  return useSyncExternalStore(subscribe, () => mq?.matches ?? false);
}
