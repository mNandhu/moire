import { useCallback, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { VirtualizedGrid } from "./VirtualizedGrid";
import { feedItem } from "../test/images";

vi.mock("./ThumbnailTile", () => ({
  ThumbnailTile: ({ item }: { item: { _id: string } }) => (
    <div data-testid="tile">{item._id}</div>
  ),
}));

const items = Array.from({ length: 300 }, (_, i) => feedItem({ _id: `L1:img${i}.png` }));

// The gallery's shape: the page finds the scroller through a ref on its own
// root, an ancestor of the grid, so the getter is null until React attaches it.
function Page() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const getScrollContainer = useCallback(
    () => containerRef.current?.parentElement ?? null,
    [],
  );
  return (
    <div ref={containerRef}>
      <VirtualizedGrid
        items={items}
        selection={new Set()}
        onToggle={() => {}}
        onOpen={() => {}}
        selectionMode={false}
        getScrollContainer={getScrollContainer}
      />
    </div>
  );
}

const tileIds = () => screen.getAllByTestId("tile").map((t) => t.textContent);

describe("VirtualizedGrid", () => {
  // jsdom lays nothing out; give every box a size so the grid can pack.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  });
  afterEach(() => vi.restoreAllMocks());

  it("packs and follows the scroller when it mounts in the same commit as the page holding the scroller ref", async () => {
    // React attaches an ancestor's ref after its children's layout effects, so
    // on a mount with the feed already cached the page's getter returns null
    // inside the grid's first layout effect.
    render(
      <div data-testid="scroller" style={{ overflowY: "auto" }}>
        <Page />
      </div>,
    );
    const first = tileIds();
    expect(first.length).toBeGreaterThan(0);
    expect(first).toContain(items[0]._id);

    // The scroll listener sits on the real scroller: scrolling it far down
    // swaps the mounted window off the top of the feed.
    const scroller = screen.getByTestId("scroller");
    await act(async () => {
      scroller.scrollTop = 20000;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(tileIds()).not.toContain(items[0]._id);
  });
});
