import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ThumbnailTile } from "./ThumbnailTile";
import type { FeedItem } from "../lib/imageFilter";
import { feedItem } from "../test/images";

beforeEach(() => {
  vi.unstubAllGlobals();
});

const doc = (d: Partial<FeedItem>): FeedItem => feedItem(d);

function renderTile(item: FeedItem, props: Partial<Parameters<typeof ThumbnailTile>[0]> = {}) {
  const onToggle = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <ThumbnailTile
      item={item}
      index={3}
      selected={false}
      selectionMode={false}
      onToggle={onToggle}
      onOpen={onOpen}
      eager
      {...props}
    />,
  );
  return { onToggle, onOpen, ...utils };
}

describe("ThumbnailTile triage state", () => {
  it("shows the score as pips when the image has been scored", () => {
    renderTile(doc({ score: 4 }));
    expect(screen.getByLabelText("Score 4 of 5")).toBeInTheDocument();
  });

  it("draws no score bar for an unscored image", () => {
    renderTile(doc({ score: 0 }));
    expect(screen.queryByLabelText(/Score|Unscored/)).not.toBeInTheDocument();
  });

  it("marks an image with no AI tags", () => {
    renderTile(doc({ has_ai_tags: false }));
    expect(screen.getByLabelText("Untagged")).toBeInTheDocument();
  });

  it("does not claim an image is untagged when the flag is unknown", () => {
    renderTile(doc({ has_ai_tags: null }));
    expect(screen.queryByLabelText("Untagged")).not.toBeInTheDocument();
  });

  it("shows quarantine state", () => {
    renderTile(doc({ quarantined: true }));
    expect(screen.getByTitle("Quarantined")).toBeInTheDocument();
  });

  it("flags a rating worth noticing but stays quiet for 'general'", () => {
    const { unmount } = renderTile(doc({ rating: "explicit" }));
    expect(screen.getByTitle("Rating: explicit")).toBeInTheDocument();
    unmount();
    renderTile(doc({ rating: "general" }));
    expect(screen.queryByTitle("Rating: general")).not.toBeInTheDocument();
  });

  it("shows the batch size for a collapsed batch", () => {
    renderTile(doc({ group_count: 7, group_id: "g1" }));
    expect(screen.getByTitle("7 variations in this batch")).toBeInTheDocument();
  });
});

/** The thumbnail itself: the first button in the tile, before the checkbox. */
const pictureButton = () => screen.getAllByRole("button")[0];

describe("ThumbnailTile selection", () => {
  it("shows no checkbox outside selection mode", () => {
    // The whole reason selection is mode-gated: a picking affordance on every
    // tile is noise on a screen whose job is looking at pictures.
    renderTile(doc({}));
    expect(screen.queryByLabelText("Select")).not.toBeInTheDocument();
  });

  it("opens the image on a click outside selection mode", () => {
    const { onOpen, onToggle } = renderTile(doc({ _id: "L1:x.png" }));
    fireEvent.click(pictureButton());
    expect(onOpen).toHaveBeenCalledWith("L1:x.png");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("shows a checkbox in selection mode", () => {
    renderTile(doc({}), { selectionMode: true });
    expect(screen.getByLabelText("Select")).toBeInTheDocument();
  });

  it("selects from the checkbox in selection mode", () => {
    const { onToggle, onOpen } = renderTile(doc({ _id: "L1:x.png" }), {
      selectionMode: true,
    });
    fireEvent.click(screen.getByLabelText("Select"));
    expect(onToggle).toHaveBeenCalledWith("L1:x.png");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("clicking the picture in selection mode picks rather than opens", () => {
    const { onToggle, onOpen } = renderTile(doc({ _id: "L1:x.png" }), {
      selectionMode: true,
    });
    fireEvent.click(pictureButton());
    expect(onToggle).toHaveBeenCalledWith("L1:x.png");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("labels the checkbox for its current state", () => {
    const { unmount } = renderTile(doc({}), {
      selectionMode: true,
      selected: true,
    });
    expect(screen.getByLabelText("Deselect")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    unmount();
    renderTile(doc({}), { selectionMode: true });
    expect(screen.getByLabelText("Select")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("ThumbnailTile batch peek", () => {
  it("resets the hover flag when selection mode engages mid-hover, instead of peeking on its own once it's turned back off", async () => {
    // Selection mode detaches the mouse handlers below (a picking affordance
    // shouldn't also be scrubbing), so the mouseleave that would normally
    // clear the hover flag never fires if selection mode engages mid-hover.
    // Without the reset effect, the flag stays stuck and the tile starts
    // peeking with the pointer nowhere near it once selection mode lifts.
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const item = doc({ group_id: "g1", group_count: 3 });
    const { container, rerender } = renderTile(item, { selectionMode: false });
    const tile = container.querySelector("[data-tile-index]")!;

    fireEvent.mouseEnter(tile);
    rerender(
      <ThumbnailTile
        item={item}
        index={3}
        selected={false}
        selectionMode
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        eager
      />,
    );
    rerender(
      <ThumbnailTile
        item={item}
        index={3}
        selected={false}
        selectionMode={false}
        onToggle={vi.fn()}
        onOpen={vi.fn()}
        eager
      />,
    );

    // Long enough for the peek's hover-intent timer to have fired if the
    // hover flag were still (wrongly) set.
    await new Promise((r) => setTimeout(r, 500));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fades the peek out on hover-exit instead of hard-cutting back to the resting thumbnail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { _id: "L1:a.png", path: "a.png", thumb_url: "/thumb/a.png" },
              { _id: "L1:b.png", path: "b.png", thumb_url: "/thumb/b.png" },
            ]),
            { status: 200 },
          ),
      ),
    );

    const item = doc({ group_id: "g1", group_count: 2 });
    const { container } = renderTile(item, { selectionMode: false });
    const tile = container.querySelector("[data-tile-index]")!;

    fireEvent.mouseEnter(tile);

    // Wait for the hover-intent delay, the fetch, and the crossfade layer to
    // actually mount.
    await waitFor(
      () =>
        expect(
          container.querySelector('img[aria-hidden="true"]'),
        ).not.toBeNull(),
      { timeout: 1000 },
    );

    fireEvent.mouseLeave(tile);

    // Immediately after leaving, the layer must still be mounted, fading
    // out, not yanked away in the same commit as the old "clear both layers
    // at once" code did.
    expect(container.querySelector('img[aria-hidden="true"]')).not.toBeNull();

    // Once the fade has had time to finish, the layer is actually gone.
    await waitFor(
      () =>
        expect(container.querySelector('img[aria-hidden="true"]')).toBeNull(),
      { timeout: 1000 },
    );
  });
});

describe("ThumbnailTile loading", () => {
  it("leaves when to load to the grid, not the browser's lazy gate", () => {
    // A native lazy <img> holds its load slot unfetched while off screen,
    // and enough of those starve the visible tiles of slots.
    const { container } = renderTile(doc({}));
    expect(container.querySelector("img")?.getAttribute("loading")).toBeNull();
  });
});
