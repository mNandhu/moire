import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  ImageLoadQueue,
  useImageLoadSlot,
  type UseImageLoadSlot,
} from "./useImageLoadSlot";

vi.mock("../lib/media", () => ({
  resolveMediaUrl: vi.fn(async (s: string) => `${s}?resolved`),
}));

let observers: Array<{ cb: IntersectionObserverCallback }> = [];

beforeEach(() => {
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
      preResolved: true,
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
    act(() => q.dequeue()); // blocking tile finishes; ours is admitted

    // It must hand the slot straight back rather than hold it forever.
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

  it("resolves the media URL when the src is not pre-resolved", async () => {
    const h = setup({ preResolved: false });

    await act(async () => {});

    expect(h.slot.assignedSrc).toBe("a.jpg?resolved");
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
