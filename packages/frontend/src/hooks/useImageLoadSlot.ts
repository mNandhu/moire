import { useEffect, useRef, useState } from "react";

/**
 * The thumbnail load-slot module: a global concurrency limit plus the per-tile
 * slot lifecycle that used to live as five refs and four effects interleaved
 * with markup inside ImageThumbnail.
 *
 * The invariants are the ones a resource pool always has, and their failure mode
 * is silent and global; leak enough slots and every subsequent thumbnail in the
 * app stops loading, with no error and no log. They are stated here as code:
 *
 *  - a tile enqueues at most once per src (a re-render during the async
 *    URL-resolve gap must not take a second slot);
 *  - every acquired slot is released exactly once, on load, on error, on
 *    unmount, or when src changes mid-flight;
 *  - a slot granted after the tile unmounted, or after its src moved on, is
 *    handed straight back.
 *
 * Token matching is what makes "exactly once" hold: a release only counts if it
 * carries the token of the slot currently held.
 */

const MAX_CONCURRENT = 12;

export class ImageLoadQueue {
  private queue: Array<() => void> = [];
  private loading = 0;

  constructor(private readonly maxConcurrent = MAX_CONCURRENT) {}

  enqueue(loadFn: () => void) {
    if (this.loading < this.maxConcurrent) {
      this.loading++;
      loadFn();
    } else {
      this.queue.push(loadFn);
    }
  }

  dequeue() {
    // Guard against a stray release outpacing acquisition: without this a
    // double-release would drive `loading` negative and silently raise the
    // effective concurrency limit for the rest of the session.
    if (this.loading === 0) return;
    this.loading--;
    if (this.queue.length > 0 && this.loading < this.maxConcurrent) {
      this.loading++;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Slots currently held. Test surface for the leak/double-release bug class. */
  get active(): number {
    return this.loading;
  }

  /** Tiles waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }
}

export const imageLoadQueue = new ImageLoadQueue();

export type UseImageLoadSlot = {
  /** The URL to put on the <img>, or null while the tile has no slot yet. */
  assignedSrc: string | null;
  loaded: boolean;
  error: boolean;
  imgRef: React.RefObject<HTMLImageElement>;
  onLoad: () => void;
  onError: () => void;
};

export function useImageLoadSlot({
  src,
  priority = false,
  eager = false,
  getRoot,
  rootMargin,
  queue = imageLoadQueue,
}: {
  src: string;
  priority?: boolean;
  eager?: boolean;
  getRoot?: () => HTMLElement | null;
  rootMargin: string;
  queue?: ImageLoadQueue;
}): UseImageLoadSlot {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [assignedSrc, setAssignedSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(
    null
  ) as React.RefObject<HTMLImageElement>;

  const mountedRef = useRef(true);
  const currentSlotTokenRef = useRef<symbol | null>(null);
  const enqueuedRef = useRef(false);
  const latestRef = useRef<{ src: string; shouldLoad: boolean }>({
    src,
    shouldLoad,
  });
  latestRef.current.src = src;
  latestRef.current.shouldLoad = shouldLoad;

  const releaseSlot = (token: symbol | null) => {
    if (token && token === currentSlotTokenRef.current) {
      currentSlotTokenRef.current = null;
      queue.dequeue();
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseSlot(currentSlotTokenRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new src is a new load: hand back the old slot before starting over.
  useEffect(() => {
    releaseSlot(currentSlotTokenRef.current);
    currentSlotTokenRef.current = null;
    enqueuedRef.current = false;
    setLoaded(false);
    setError(false);
    setAssignedSrc(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Gate: priority/eager tiles load on mount, everything else waits for the
  // IntersectionObserver. The observer root must be the real scrolling element:
  // rootMargin only expands the root, while intermediate scroll containers clip
  // at zero margin, killing the preload window.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    if (priority || eager) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setShouldLoad(true);
            observer.disconnect();
          }
        });
      },
      { root: getRoot?.() ?? null, rootMargin, threshold: 0.01 }
    );

    observer.observe(img);
    return () => observer.disconnect();
  }, [priority, eager, getRoot, rootMargin]);

  // Acquire a slot, and only then assign the real <img src>, assigning earlier
  // would double-fetch (a preload Image() plus the <img>).
  useEffect(() => {
    if (!shouldLoad || loaded || error || !src) return;
    if (assignedSrc || enqueuedRef.current) return;

    enqueuedRef.current = true;
    const srcAtEnqueue = src;
    queue.enqueue(() => {
      // Granted late: the tile may have gone away or moved on. Hand it back.
      if (!mountedRef.current) {
        queue.dequeue();
        return;
      }
      if (
        !latestRef.current.shouldLoad ||
        latestRef.current.src !== srcAtEnqueue
      ) {
        queue.dequeue();
        return;
      }

      const token = Symbol("loadToken");
      currentSlotTokenRef.current = token;

      // src is the list payload's versioned thumbnail URL: assign directly.
      setAssignedSrc(srcAtEnqueue);
    });
  }, [shouldLoad, loaded, error, assignedSrc, src, queue]);

  return {
    assignedSrc,
    loaded,
    // No URL to load (a row without thumb_url) shows as the error state.
    error: error || !src,
    imgRef,
    onLoad: () => {
      if (!mountedRef.current) return;
      setLoaded(true);
      releaseSlot(currentSlotTokenRef.current);
    },
    onError: () => {
      if (!mountedRef.current) return;
      setError(true);
      releaseSlot(currentSlotTokenRef.current);
    },
  };
}
