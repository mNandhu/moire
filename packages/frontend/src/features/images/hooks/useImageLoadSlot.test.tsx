import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  ImageLoadQueue,
  resetSeenThumbnails,
  useImageLoadSlot,
  type UseImageLoadSlot,
} from "./useImageLoadSlot";

let observers: Array<{ cb: IntersectionObserverCallback }> = [];

beforeEach(() => {
  resetSeenThumbnails();
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb });
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Props = Omit<Parameters<typeof useImageLoadSlot>[0], "rootMargin"> & {
  rootMargin?: string;
};

/**
 * The hook gates on a mounted <img>, so the ref has to be attached during
 * render; a bare renderHook never populates it.
 */
function setup(props: Partial<Props> = {}, maxConcurrent = 12) {
  const queue = props.queue ?? new ImageLoadQueue(maxConcurrent);
  let slot!: UseImageLoadSlot;

  function Harness({ src }: { src: string }) {
    slot = useImageLoadSlot({
      eager: true,
      rootMargin: "0px",
      queue,
      ...props,
      src,
    });
    return <img ref={slot.imgRef} alt="" />;
  }

  const initialSrc = props.src ?? "a.jpg";
  const view = render(<Harness src={initialSrc} />);
  return {
    queue,
    get slot() {
      return slot;
    },
    setSrc: (src: string) => view.rerender(<Harness src={src} />),
    unmount: view.unmount,
  };
}

describe("ImageLoadQueue", () => {
  it("runs up to maxConcurrent immediately and queues the rest", () => {
    const q = new ImageLoadQueue(2);
    const ran: number[] = [];
    for (let i = 0; i < 4; i++) q.enqueue(() => ran.push(i));

    expect(ran).toEqual([0, 1]);
    expect(q.active).toBe(2);
    expect(q.waiting).toBe(2);
  });

  it("releasing a slot admits the next waiter", () => {
    const q = new ImageLoadQueue(1);
    const ran: number[] = [];
    q.enqueue(() => ran.push(0));
    q.enqueue(() => ran.push(1));
    expect(ran).toEqual([0]);

    q.dequeue();

    expect(ran).toEqual([0, 1]);
    expect(q.waiting).toBe(0);
  });

  it("a stray release cannot drive the slot count negative", () => {
    // Without the guard this permanently raises the effective concurrency
    // limit: the silent, global failure mode this module exists to prevent.
    const q = new ImageLoadQueue(1);
    q.dequeue();
    q.dequeue();
    expect(q.active).toBe(0);

    const ran: number[] = [];
    q.enqueue(() => ran.push(0));
    q.enqueue(() => ran.push(1));
    expect(ran).toEqual([0]); // still limited to 1
  });

  describe("nearest-first", () => {
    const view = { top: 1000, bottom: 1600 };
    const at = (top: number) => () => ({ top, bottom: top + 100 });

    function fill(q: ImageLoadQueue, tops: Array<number | null>) {
      const ran: number[] = [];
      q.enqueue(() => {}); // holds the only slot
      tops.forEach((t, i) =>
        q.enqueue(() => ran.push(i), t === null ? undefined : at(t)),
      );
      return ran;
    }

    it("grants the waiter nearest the viewport, not the oldest", () => {
      const q = new ImageLoadQueue(1);
      q.setView(view);
      const ran = fill(q, [0, 5000, 1700]);
      q.dequeue();
      expect(ran).toEqual([2]);
      expect(q.active).toBe(1);
      expect(q.waiting).toBe(2);
    });

    it("keeps FIFO order among equally near waiters", () => {
      const q = new ImageLoadQueue(1);
      q.setView(view);
      const ran = fill(q, [1100, 1200, 1300]);
      for (let i = 0; i < 3; i++) q.dequeue();
      expect(ran).toEqual([0, 1, 2]);
    });

    it("serves a waiter with no position instead of starving it", () => {
      const q = new ImageLoadQueue(1);
      q.setView(view);
      const ran = fill(q, [1700, null, 1100]);
      q.dequeue();
      q.dequeue();
      q.dequeue();
      expect(ran).toEqual([1, 2, 0]);
    });

    it("is plain FIFO when no viewport is known", () => {
      const q = new ImageLoadQueue(1);
      const ran = fill(q, [5000, 1000, 3000]);
      for (let i = 0; i < 3; i++) q.dequeue();
      expect(ran).toEqual([0, 1, 2]);
    });

    it("grants each waiter once and keeps the slot count right", () => {
      const q = new ImageLoadQueue(2);
      q.setView(view);
      const ran: number[] = [];
      for (let i = 0; i < 6; i++) q.enqueue(() => ran.push(i), at(i * 800));
      expect(q.active).toBe(2);
      expect(q.waiting).toBe(4);
      for (let i = 0; i < 6; i++) q.dequeue();
      expect(ran.length).toBe(6);
      expect(new Set(ran).size).toBe(6);
      expect(q.active).toBe(0);
      expect(q.waiting).toBe(0);
    });

    it("drops a cancelled waiter without touching the slot count", () => {
      const q = new ImageLoadQueue(1);
      q.enqueue(() => {});
      const ran: number[] = [];
      const cancel = q.enqueue(() => ran.push(1));
      q.enqueue(() => ran.push(2));
      cancel();
      expect(q.waiting).toBe(1);
      expect(q.active).toBe(1);
      q.dequeue();
      expect(ran).toEqual([2]);
    });

    it("cancel is a no-op once the waiter was granted", () => {
      const q = new ImageLoadQueue(1);
      const cancel = q.enqueue(() => {});
      cancel();
      expect(q.active).toBe(1);
    });
  });
});

describe("useImageLoadSlot", () => {
  it("takes a slot and assigns the src once allowed to load", () => {
    const h = setup();

    expect(h.slot.assignedSrc).toBe("a.jpg");
    expect(h.queue.active).toBe(1);
  });

  it("releases the slot when the image settles", () => {
    const h = setup();
    expect(h.queue.active).toBe(1);

    act(() => h.slot.onLoad());

    expect(h.slot.loaded).toBe(true);
    expect(h.queue.active).toBe(0);
  });

  it("releases the slot on error too", () => {
    const h = setup();

    act(() => h.slot.onError());

    expect(h.slot.error).toBe(true);
    expect(h.queue.active).toBe(0);
  });

  it("does not double-release when the image settles twice", () => {
    // A double-release is the leak's mirror image: it frees a slot the tile
    // never held, letting the queue over-admit for the rest of the session.
    const h = setup();
    act(() => h.slot.onLoad());
    expect(h.queue.active).toBe(0);

    act(() => h.slot.onLoad());
    act(() => h.slot.onError());

    expect(h.queue.active).toBe(0);
  });

  it("releases the slot on unmount mid-load", () => {
    const h = setup();
    expect(h.queue.active).toBe(1);

    act(() => h.unmount());

    expect(h.queue.active).toBe(0);
  });

  it("hands the old slot back when src changes mid-load", () => {
    const h = setup();
    expect(h.queue.active).toBe(1);

    act(() => h.setSrc("b.jpg"));

    // Exactly one slot: the old released, a new one taken for b.jpg.
    expect(h.queue.active).toBe(1);
    expect(h.slot.assignedSrc).toBe("b.jpg");
    expect(h.slot.loaded).toBe(false);
  });

  it("takes only one slot across re-renders with an unchanged src", () => {
    const h = setup();

    act(() => h.setSrc("a.jpg"));
    act(() => h.setSrc("a.jpg"));

    expect(h.queue.active).toBe(1);
  });

  it("hands back a slot granted after the tile unmounted", () => {
    // Queue full, so this tile waits; it unmounts before its turn comes.
    const q = new ImageLoadQueue(1);
    q.enqueue(() => {});
    expect(q.active).toBe(1);

    const h = setup({ queue: q, src: "late.jpg" });
    expect(q.waiting).toBe(1);

    act(() => h.unmount());
    // Unmounting drops it from the queue, so it is never scanned or granted.
    expect(q.waiting).toBe(0);
    act(() => q.dequeue()); // blocking tile finishes

    // No slot is left held.
    expect(q.active).toBe(0);
  });

  it("hands back a slot granted after src moved on", () => {
    const q = new ImageLoadQueue(1);
    q.enqueue(() => {});

    const h = setup({ queue: q, src: "old.jpg" });
    expect(q.waiting).toBe(1);

    act(() => h.setSrc("new.jpg"));
    act(() => q.dequeue());

    // The stale enqueue must not hold a slot for a src nobody wants.
    expect(q.active).toBeLessThanOrEqual(1);
    expect(h.slot.assignedSrc).not.toBe("old.jpg");
  });

  it("a freed slot reaches the waiting tile nearest the viewport", () => {
    const q = new ImageLoadQueue(1);
    q.setView({ top: 0, bottom: 100 });
    q.enqueue(() => {});
    const far = setup({
      queue: q,
      src: "far.jpg",
      getSpan: () => ({ top: 5000, bottom: 5100 }),
    });
    const near = setup({
      queue: q,
      src: "near.jpg",
      getSpan: () => ({ top: 200, bottom: 300 }),
    });

    act(() => q.dequeue());

    expect(near.slot.assignedSrc).toBe("near.jpg");
    expect(far.slot.assignedSrc).toBeNull();
  });

  it("shows an error and takes no slot when there is no src", () => {
    const h = setup({ src: "" });

    expect(h.slot.error).toBe(true);
    expect(h.slot.assignedSrc).toBe(null);
    expect(h.queue.active).toBe(0);
  });

  it("waits for the observer to fire when not eager or priority", () => {
    const h = setup({ eager: false });

    expect(h.slot.assignedSrc).toBe(null);
    expect(h.queue.active).toBe(0);

    act(() => {
      observers[observers.length - 1].cb(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(h.slot.assignedSrc).toBe("a.jpg");
    expect(h.queue.active).toBe(1);
  });
});

describe("useImageLoadSlot, seen thumbnails", () => {
  /** Load a url once in its own tile, then unmount it, as a scrolled-away tile does. */
  function loadOnce(src: string) {
    const first = setup({ src });
    act(() => first.slot.onLoad());
    act(() => first.unmount());
  }

  it("lets a seen url render at once with no slot", () => {
    loadOnce("a.jpg");

    const h = setup({ src: "a.jpg" });

    expect(h.slot.instant).toBe(true);
    expect(h.slot.assignedSrc).toBe("a.jpg");
    expect(h.queue.active).toBe(0);
    expect(h.queue.waiting).toBe(0);
  });

  it("does not release a slot it never took", () => {
    loadOnce("a.jpg");
    const q = new ImageLoadQueue(1);
    q.enqueue(() => {}); // another tile holds the only slot
    const h = setup({ src: "a.jpg", queue: q });

    act(() => h.slot.onLoad());
    act(() => h.unmount());

    expect(q.active).toBe(1);
  });

  it("still queues an unseen url", () => {
    loadOnce("a.jpg");

    const h = setup({ src: "b.jpg" });

    expect(h.slot.instant).toBe(false);
    expect(h.queue.active).toBe(1);
  });

  it("keeps the placeholder until the image can paint", () => {
    loadOnce("a.jpg");

    const h = setup({ src: "a.jpg" });

    // Seen is not loaded: the image may still need a cache or network read.
    expect(h.slot.loaded).toBe(false);
    act(() => h.slot.onLoad());
    expect(h.slot.loaded).toBe(true);
    expect(h.slot.instant).toBe(true);
  });

  it("is loaded from the first paint when the browser already has the image", () => {
    loadOnce("a.jpg");
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const width = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(64);

    const h = setup({ src: "a.jpg" });

    expect(h.slot.loaded).toBe(true);
    expect(h.slot.holdPlaceholder).toBe(false);
    complete.mockRestore();
    width.mockRestore();
  });

  it("does not mark a failed load as seen", () => {
    const first = setup({ src: "bad.jpg" });
    act(() => first.slot.onError());
    act(() => first.unmount());

    const h = setup({ src: "bad.jpg" });

    expect(h.slot.instant).toBe(false);
    expect(h.queue.active).toBe(1);
  });

  it("shows the error state when an instant tile fails, and forgets the url", () => {
    loadOnce("a.jpg");
    const h = setup({ src: "a.jpg" });

    act(() => h.slot.onError());
    expect(h.slot.error).toBe(true);
    expect(h.queue.active).toBe(0);
    act(() => h.unmount());

    const again = setup({ src: "a.jpg" });
    expect(again.slot.instant).toBe(false);
    expect(again.queue.active).toBe(1);
  });

  it("a first load does not turn the tile instant", () => {
    const h = setup({ src: "a.jpg" });
    act(() => h.slot.onLoad());

    expect(h.slot.instant).toBe(false);
  });

  it("moving from an unseen url to a seen one frees its slot and takes none", () => {
    loadOnce("seen.jpg");
    const h = setup({ src: "fresh.jpg" });
    expect(h.queue.active).toBe(1);

    act(() => h.setSrc("seen.jpg"));

    expect(h.slot.instant).toBe(true);
    expect(h.slot.assignedSrc).toBe("seen.jpg");
    expect(h.queue.active).toBe(0);
    expect(h.queue.waiting).toBe(0);
  });

  it("moving from an unseen url still waiting for a slot to a seen one leaves the queue alone", () => {
    loadOnce("seen.jpg");
    const q = new ImageLoadQueue(1);
    q.enqueue(() => {});
    const h = setup({ src: "fresh.jpg", queue: q });
    expect(q.waiting).toBe(1);

    act(() => h.setSrc("seen.jpg"));
    expect(h.slot.assignedSrc).toBe("seen.jpg");
    expect(q.waiting).toBe(0); // the stale waiter left the queue
    act(() => q.dequeue()); // the blocker finishes

    expect(q.active).toBe(0);
    expect(q.waiting).toBe(0);
  });

  it("moving to a seen url is not loaded by the old image's complete flag", () => {
    loadOnce("seen.jpg");
    const h = setup({ src: "fresh.jpg" });
    act(() => h.slot.onLoad());
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const width = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(64);

    act(() => h.setSrc("seen.jpg"));

    expect(h.slot.assignedSrc).toBe("seen.jpg");
    expect(h.slot.loaded).toBe(false);
    complete.mockRestore();
    width.mockRestore();
  });

  it("moving from a seen url to an unseen one takes a slot", () => {
    loadOnce("seen.jpg");
    const h = setup({ src: "seen.jpg" });
    expect(h.queue.active).toBe(0);

    act(() => h.setSrc("fresh.jpg"));

    expect(h.slot.instant).toBe(false);
    expect(h.slot.loaded).toBe(false);
    expect(h.slot.assignedSrc).toBe("fresh.jpg");
    expect(h.queue.active).toBe(1);
  });
});
