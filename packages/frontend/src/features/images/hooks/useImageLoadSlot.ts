import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { pickNearest, type Span } from "@/features/images/lib/loadOrder";

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
 * A URL that already loaded this session is "seen" and skips the queue (see
 * `seenSrc` below); such a tile never holds a slot, so it never releases one.
 *
 * Token matching is what makes "exactly once" hold: a release only counts if it
 * carries the token of the slot currently held.
 */

const MAX_CONCURRENT = 12;

type Waiter = { load: () => void; span?: () => Span | null | undefined };

export class ImageLoadQueue {
  private queue: Waiter[] = [];
  private loading = 0;
  private view: Span | null = null;

  constructor(private readonly maxConcurrent = MAX_CONCURRENT) {}

  /**
   * Where the viewport is, in the same scroll-content coordinates as the spans
   * waiters report. With it, a free slot goes to the waiter nearest the
   * viewport instead of the oldest, so a fast scroll does not spend its slots
   * on tiles already scrolled past. Null (no grid mounted) means plain FIFO.
   */
  setView(view: Span | null) {
    this.view = view;
  }

  /**
   * Returns a cancel function that drops the waiter if it is still queued, so
   * a tile that unmounted while waiting stops being scanned. It does nothing
   * once the slot was granted; the holder releases it as before.
   */
  enqueue(
    loadFn: () => void,
    span?: () => Span | null | undefined,
  ): () => void {
    if (this.loading < this.maxConcurrent) {
      this.loading++;
      loadFn();
      return () => {};
    }
    const waiter: Waiter = { load: loadFn, span };
    this.queue.push(waiter);
    return () => {
      const i = this.queue.indexOf(waiter);
      if (i >= 0) this.queue.splice(i, 1);
    };
  }

  dequeue() {
    // Guard against a stray release outpacing acquisition: without this a
    // double-release would drive `loading` negative and silently raise the
    // effective concurrency limit for the rest of the session.
    if (this.loading === 0) return;
    this.loading--;
    if (this.queue.length > 0 && this.loading < this.maxConcurrent) {
      this.loading++;
      const at = pickNearest(
        this.queue.map((w) => w.span?.()),
        this.view,
      );
      const [next] = this.queue.splice(at, 1);
      if (next) next.load();
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

/** The app-wide queue; the virtualized grid reports its viewport to it. */
export const imageLoadQueue = new ImageLoadQueue();

/**
 * Thumbnail URLs that fired `onLoad` this session. Thumbnail URLs are versioned
 * (`?v=`), so a stale entry can never show an old image; the worst a wrong entry
 * does is send a tile down the instant path for an image the browser no longer
 * has, which still loads, only without a queue slot. Bounded because it is a
 * long-lived module global: past the cap the oldest entries fall out (Set keeps
 * insertion order). The browser's own memory cache is far smaller than this, so
 * the cap costs nothing a user would notice.
 */
const MAX_SEEN = 5000;
const seenSrc = new Set<string>();

function markSeen(src: string) {
  seenSrc.delete(src); // re-insert so a reload counts as recent
  seenSrc.add(src);
  if (seenSrc.size > MAX_SEEN) {
    const oldest = seenSrc.values().next().value;
    if (oldest !== undefined) seenSrc.delete(oldest);
  }
}

/** Test-only: forget every seen URL so tests do not leak into each other. */
export function resetSeenThumbnails() {
  seenSrc.clear();
}

export type UseImageLoadSlot = {
  /**
   * The URL loaded earlier this session, so this tile takes no slot and should
   * not fade in. Decided when the tile mounts or its src changes, and fixed
   * after that: the URL entering the seen set because this tile just loaded it
   * must not flip a normal first load into an instant one.
   */
  instant: boolean;
  /**
   * An instant tile has not yet checked whether the browser already has the
   * image decoded. The placeholder should not spend a BlurHash decode until
   * that check is done; if the image is ready the placeholder is never needed.
   */
  holdPlaceholder: boolean;
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
  span,
  queue = imageLoadQueue,
}: {
  src: string;
  priority?: boolean;
  eager?: boolean;
  getRoot?: () => HTMLElement | null;
  rootMargin: string;
  /** The tile's vertical extent in scroll-content px, when the caller knows it
   * (the virtualized grid). Lets the queue serve the nearest tile first. */
  span?: Span;
  queue?: ImageLoadQueue;
}): UseImageLoadSlot {
  // Decided per src, during render, so the slot-acquire effect below sees the
  // right answer in the same commit that a src change lands in.
  const [mode, setMode] = useState(() => ({
    src,
    instant: seenSrc.has(src),
  }));
  let instant = mode.instant;
  if (mode.src !== src) {
    instant = seenSrc.has(src);
    setMode({ src, instant });
  }
  // The src whose already-loaded check has run (instant tiles only).
  const [probedSrc, setProbedSrc] = useState<string | null>(null);

  // `loaded` stays false for an instant tile until the browser says the image
  // can paint (the img's load event, or `complete` at mount). "Seen" only means
  // we fetched it before; it may since have left the memory cache and need a
  // disk or network read, and starting loaded would hide the BlurHash and show
  // a bare tile for that gap.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [assignedSrc, setAssignedSrc] = useState<string | null>(
    instant ? src : null
  );
  const imgRef = useRef<HTMLImageElement>(
    null
  ) as React.RefObject<HTMLImageElement>;

  const mountedRef = useRef(true);
  const currentSlotTokenRef = useRef<symbol | null>(null);
  const enqueuedRef = useRef(false);
  const cancelQueuedRef = useRef<(() => void) | null>(null);
  const spanRef = useRef(span);
  spanRef.current = span;
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
      cancelQueuedRef.current?.();
      releaseSlot(currentSlotTokenRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new src is a new load: hand back the old slot before starting over. A
  // layout effect, so that an instant tile whose image is already complete can
  // be marked loaded before the first paint, with no flash of the placeholder.
  useLayoutEffect(() => {
    releaseSlot(currentSlotTokenRef.current);
    currentSlotTokenRef.current = null;
    enqueuedRef.current = false;
    const img = imgRef.current;
    setLoaded(instant && !!img?.complete && img.naturalWidth > 0);
    setError(false);
    setAssignedSrc(instant ? src : null);
    if (instant) setProbedSrc(src);
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
    if (instant || !shouldLoad || loaded || error || !src) return;
    if (assignedSrc || enqueuedRef.current) return;

    enqueuedRef.current = true;
    const srcAtEnqueue = src;
    cancelQueuedRef.current = queue.enqueue(() => {
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
    }, () => spanRef.current);
  }, [instant, shouldLoad, loaded, error, assignedSrc, src, queue]);

  return {
    instant,
    holdPlaceholder: instant && probedSrc !== src,
    assignedSrc,
    loaded,
    // No URL to load (a row without thumb_url) shows as the error state.
    error: error || !src,
    imgRef,
    onLoad: () => {
      if (!mountedRef.current) return;
      markSeen(src);
      setLoaded(true);
      releaseSlot(currentSlotTokenRef.current);
    },
    onError: () => {
      if (!mountedRef.current) return;
      // A failed URL is never seen, and one that was must go through the
      // queue again next time.
      seenSrc.delete(src);
      setError(true);
      releaseSlot(currentSlotTokenRef.current);
    },
  };
}
