import { useEffect, useRef, useState } from "react";

/**
 * A server's seconds count (a running request's `elapsed`, refreshed by each
 * poll) carried forward on the local clock between polls, so a countdown
 * ticks every second instead of jumping when the next poll lands. Never
 * runs backwards: a poll that lands a little behind the local count is
 * ignored until it catches up. Null while the server has no count.
 */
export function useLiveSeconds(server: number | null | undefined, live: boolean): number | null {
  // Where the count was when the server last said, and when that was.
  const anchor = useRef<{ at: number; seconds: number } | null>(null);
  const shown = useRef(0);
  const [now, setNow] = useState(() => performance.now());

  if (server == null) {
    anchor.current = null;
    shown.current = 0;
  } else if (!anchor.current || server > anchor.current.seconds + (performance.now() - anchor.current.at) / 1000) {
    anchor.current = { at: performance.now(), seconds: server };
  }

  useEffect(() => {
    if (!live || server == null) return;
    const id = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(id);
  }, [live, server == null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!anchor.current) return null;
  const seconds = live ? anchor.current.seconds + Math.max(0, now - anchor.current.at) / 1000 : anchor.current.seconds;
  shown.current = Math.max(shown.current, seconds);
  return shown.current;
}
