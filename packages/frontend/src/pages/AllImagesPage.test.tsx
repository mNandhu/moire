import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../components/Toasts";
import AllImagesPage from "./AllImagesPage";
import { ShortcutHelp } from "../components/ShortcutOverlay";

// Opening a tile navigates; spying on the router hook is the cheapest way to
// assert that without mounting the ImageView route.
const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

/**
 * Wiring-level cover for the gallery page.
 *
 * The page owns the parts that only break once everything is assembled: the
 * global key handling, the selection-mode gate on the tile checkboxes, and the
 * loading -> empty transition. Unit tests of the pure helpers can't see any of
 * that.
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

function stubFetch(images: unknown[], libraries: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("/api/v1/libraries")
        ? libraries
        : url.includes("/api/v1/tags") || url.includes("/api/v1/images/models")
          ? []
          : images;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

function renderPage(url = "/") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <AllImagesPage />
          <ShortcutHelp />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/**
 * Give jsdom a viewport.
 *
 * jsdom performs no layout, so every element reports clientWidth 0, and the
 * grid, correctly, packs nothing at zero width. Without this the page renders
 * with no tiles at all and any assertion about tile-level UI passes or fails
 * for the wrong reason. Fixing the width makes the real packing run: at 1280px
 * and the default 250px target that is 5 columns of actual tiles.
 */
const VIEWPORT_W = 1280;
const VIEWPORT_H = 900;

beforeEach(() => {
  navigateSpy.mockClear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
    VIEWPORT_W,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    VIEWPORT_H,
  );
  stubFetch(IMAGES);
});

/**
 * Wait for the feed to actually land. The "loaded" qualifier renders straight
 * away next to a count of zero, so waiting on it alone lets a test fire
 * shortcuts against an empty grid, where, correctly, they do nothing.
 */
const awaitFeed = (n = IMAGES.length) =>
  screen.findByText(String(n), { selector: "span" });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AllImagesPage", () => {
  it("renders a tile per image once the feed lands", async () => {
    renderPage();
    // Guards the whole file: if the grid packs nothing, every other assertion
    // about tile UI below would pass vacuously.
    await waitFor(() =>
      expect(screen.getAllByRole("img")).toHaveLength(IMAGES.length),
    );
  });

  it("labels the header count as loaded-so-far, not as a total", async () => {
    renderPage();
    // The feed is cursor-paged and the API exposes no total; a bare number that
    // grows as you scroll reads as a wrong count.
    expect(await screen.findByText("loaded")).toBeInTheDocument();
  });

  it("shows an empty state once a filtered feed comes back empty", async () => {
    stubFetch([]);
    renderPage();
    expect(await screen.findByText("No images found")).toBeInTheDocument();
  });

  it("shows library scope as tabs, not as a chip", async () => {
    const libs = [
      { _id: "L1", name: "Alpha", path: "/a", indexed_count: 3 },
      { _id: "L2", name: "Beta", path: "/b", indexed_count: 3 },
    ];
    stubFetch(IMAGES, libs);
    renderPage("/?library_id=L2");
    expect(await screen.findByRole("button", { name: /^Beta/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByText(/^Library:/)).not.toBeInTheDocument();
  });

  it("keeps a stale library link visible and clearable as a chip", async () => {
    // No tab can show a library that no longer exists; without the chip the
    // feed would be empty with nothing on screen explaining why.
    stubFetch([], [
      { _id: "L1", name: "Alpha", path: "/a" },
      { _id: "L2", name: "Beta", path: "/b" },
    ]);
    renderPage("/?library_id=gone");
    expect(await screen.findByText("Library: not found")).toBeInTheDocument();
  });

  it("opens and closes the shortcut overlay with ?", async () => {
    renderPage();
    await awaitFeed();

    fireEvent.keyDown(window, { key: "?" });
    expect(
      await screen.findByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows no selection checkboxes until selection mode is entered", async () => {
    renderPage();
    await awaitFeed();
    // The point of the mode: a picking affordance on every tile is noise on a
    // screen whose job is looking at pictures.
    expect(screen.queryAllByLabelText("Select")).toHaveLength(0);

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select").length).toBeGreaterThan(0),
    );
  });

  it("S leaves selection mode again and takes the checkboxes with it", async () => {
    renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select").length).toBeGreaterThan(0),
    );

    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select")).toHaveLength(0),
    );
  });

  it("Escape leaves selection mode", async () => {
    renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select").length).toBeGreaterThan(0),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select")).toHaveLength(0),
    );
  });


  it("persists the density preference across mounts", async () => {
    const first = renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "-" });
    await waitFor(() =>
      expect(localStorage.getItem("gallery:density")).toBe("3"),
    );
    first.unmount();

    renderPage();
    await awaitFeed();
    // Remounting must not reset the user's zoom back to the default.
    expect(localStorage.getItem("gallery:density")).toBe("3");
  });

  it("leaves selection mode when the filter changes", async () => {
    renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.click((await screen.findAllByLabelText("Select"))[0]);
    // "1 selected" shows in both the page header and the actions dropdown.
    await waitFor(() =>
      expect(screen.getAllByText("1 selected").length).toBeGreaterThan(0),
    );

    // Changing the filter swaps the feed underneath; a surviving selection
    // would aim the bulk actions at images no longer on screen.
    fireEvent.keyDown(window, { key: "q" });

    await waitFor(() =>
      expect(screen.queryAllByLabelText("Select")).toHaveLength(0),
    );
  });


  it("does not act on filter shortcuts while the help overlay is open", async () => {
    renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    // Reading "Q: quarantined" in the overlay and pressing Q used to switch
    // the feed underneath it, invisibly. Keys come from an element, as in a
    // browser, so the dialog sees them on their way to the window.
    fireEvent.keyDown(document.body, { key: "q" });
    fireEvent.keyDown(document.body, { key: "s" });

    expect(screen.queryAllByLabelText("Select")).toHaveLength(0);
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeInTheDocument();
    // Still the default feed, not the quarantined view.
    expect(screen.queryByText("Quarantined Images")).not.toBeInTheDocument();
  });

  it("Escape still closes the help overlay", async () => {
    renderPage();
    await awaitFeed();
    fireEvent.keyDown(window, { key: "?" });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("Enter opens the focused tile", async () => {
    renderPage();
    await awaitFeed();

    // Arrow to the first tile, then activate it. The focused element is a
    // tabIndex={-1} wrapper, so there is no default activation to rely on.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.stringContaining("/image/"),
        expect.objectContaining({ state: expect.anything() }),
      ),
    );
  });

  it("ignores shortcuts typed into the search field", async () => {
    renderPage();
    await awaitFeed();
    const search = screen.getByPlaceholderText(/^Search tags/);

    fireEvent.keyDown(search, { key: "?" });
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeInTheDocument();

    // "s" is the selection-mode toggle, and must stay typeable in a tag search.
    fireEvent.keyDown(search, { key: "s" });
    expect(screen.queryAllByLabelText("Select")).toHaveLength(0);
  });
});
