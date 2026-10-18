import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "./components/Toasts";
import RootRoutes from "./RootRoutes";

/**
 * Regression cover for the gallery <-> ImageView round trip.
 *
 * ImageView used to live on a route that was a sibling of the gallery's, so
 * opening it unmounted `App`/`AllImagesPage` entirely; every tile's load state
 * (decoded-image cache, entrance animation, load-queue slot) reset, which is
 * what produced the ~1s "everything fades back in" delay on return. The fix
 * (RootRoutes) opens ImageView as an overlay over a `<Routes>` frozen on the
 * gallery's background location, so the gallery subtree is never torn down.
 *
 * This is worth testing at the DOM-identity level rather than just asserting
 * "no crash": the whole point of the fix is that specific nodes survive, not
 * just that equivalent ones get recreated.
 */

const IMAGES = Array.from({ length: 6 }, (_, i) => ({
  _id: `L1:img-${i}.png`,
  path: `img-${i}.png`,
  width: 512,
  height: 768,
  score: i,
  quarantined: false,
  has_ai_tags: false,
  thumb_url: `/api/v1/images/L1%3Aimg-${i}.png/thumb`,
}));

function stubFetch(images: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body =
        url.includes("/api/v1/libraries") ||
        url.includes("/api/v1/tags") ||
        url.includes("/api/v1/images/models")
          ? []
          : images;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    VIEWPORT_W,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    VIEWPORT_H,
  );
  stubFetch(IMAGES);
});

describe("RootRoutes", () => {
  it("keeps the gallery mounted while ImageView is open, and after closing it", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/"]}>
            <RootRoutes />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Wait for the feed to land and the grid to pack its first tile.
    await waitFor(() => {
      expect(container.querySelectorAll("img").length).toBeGreaterThan(0);
    });

    const scrollContainer = container.querySelector(".flex-1.overflow-auto");
    expect(scrollContainer).not.toBeNull();

    // Open the focused tile: real navigation, not a mocked `navigate`.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Enter" });

    const backButton = await screen.findByRole("button", { name: "Back" });
    expect(backButton).toBeInTheDocument();

    // The gallery's scroll container must still be the exact same node:
    // proof `App`/`AllImagesPage` never unmounted underneath the overlay.
    expect(container.querySelector(".flex-1.overflow-auto")).toBe(
      scrollContainer,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Back" }),
      ).not.toBeInTheDocument();
    });

    // Still the same node after the round trip.
    expect(container.querySelector(".flex-1.overflow-auto")).toBe(
      scrollContainer,
    );
  });
});
