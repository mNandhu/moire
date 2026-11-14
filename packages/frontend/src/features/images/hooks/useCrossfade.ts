import { useEffect, useRef, useState } from "react";

// Must match the `duration-300` class on the crossfade layers that render
// this: the exit fade sets both layers to opacity-0 and waits this long for
// that transition to finish before unmounting the <img> nodes.
export const CROSSFADE_MS = 300;

/**
 * Two stacked layers that swap which one is "front" on every `src` change, so
 * each step (including a wrap back to an earlier frame) is a dissolve between
 * the previous frame and the next rather than a hard cut. A single <img>
 * whose src is swapped in place can't do this: only a fresh element (or a
 * genuinely new opacity target) retriggers a CSS transition.
 *
 * `front` is the layer to show at opacity-100; `null` means neither, both fade
 * to opacity-0. That happens only when `src` goes null, so the layers stay
 * mounted long enough to actually play the fade before they clear.
 */
export function useCrossfade(src: string | null) {
  const [layers, setLayers] = useState<[string | null, string | null]>([null, null]);
  const [front, setFront] = useState<0 | 1 | null>(0);
  const lastSrc = useRef<string | null>(null);

  useEffect(() => {
    if (!src) {
      if (lastSrc.current === null) return;
      lastSrc.current = null;
      // Fade the visible layer out to opacity-0 rather than unmounting both
      // <img> layers in the same commit; removing the nodes immediately
      // skipped the opacity transition and hard-cut straight back.
      setFront(null);
      const t = setTimeout(() => setLayers([null, null]), CROSSFADE_MS);
      return () => clearTimeout(t);
    }
    if (src === lastSrc.current) return;
    lastSrc.current = src;
    const back = front === 0 ? 1 : 0;
    setLayers((prev) => {
      const next: [string | null, string | null] = [...prev];
      next[back] = src;
      return next;
    });
    // Paint the new frame into the hidden layer first, then flip which layer
    // is front on the next tick; flipping in the same update risks the
    // browser coalescing both style changes and skipping the transition.
    const raf = requestAnimationFrame(() => setFront(back));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return { layers, front };
}
