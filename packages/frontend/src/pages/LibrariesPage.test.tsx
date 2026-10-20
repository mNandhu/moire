import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toasts";
import LibrariesPage from "./LibrariesPage";

// Regression guard: removing a library must invalidate BOTH gallery caches:
// the flat feed (`["images"]`) and the batch-collapsed grouped view
// (`["image-groups"]`). The grouped view was added later; an invalidation that
// only dropped `["images"]` left the grouped gallery serving images from a
// removed library until a manual reload.
describe("LibrariesPage › delete invalidates the gallery", () => {
  beforeEach(() => {
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          return new Response(JSON.stringify({ removed: "lib1" }), { status: 200 });
        }
        // initial library list
        return new Response(
          JSON.stringify([{ _id: "lib1", name: "Lib One", path: "/imgs" }]),
          { status: 200 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops both the flat feed and the grouped view on delete", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");

    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <MemoryRouter>
            <LibrariesPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    // Delete lives in the row's overflow menu.
    fireEvent.click(
      await screen.findByRole("button", { name: "More actions for Lib One" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
      expect(keys).toContain(JSON.stringify(["images"]));
      expect(keys).toContain(JSON.stringify(["image-groups"]));
    });
  });
});

describe("LibrariesPage › deleting several", () => {
  const deleted: string[] = [];
  beforeEach(() => {
    deleted.length = 0;
    vi.stubGlobal("confirm", () => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          deleted.push(String(url).split("/").pop()!);
          return new Response("{}", { status: 200 });
        }
        return new Response(
          JSON.stringify([
            { _id: "inner", name: "Inner", path: "/art/out/inner" },
            { _id: "outer", name: "Outer", path: "/art/out" },
            { _id: "other", name: "Other", path: "/photos" },
          ]),
          { status: 200 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes the picked libraries, outermost first", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter>
            <LibrariesPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    fireEvent.click(screen.getByLabelText("Select Inner"));
    fireEvent.click(screen.getByLabelText("Select Outer"));
    fireEvent.click(screen.getByRole("button", { name: "Delete 2" }));

    await waitFor(() => expect(deleted).toEqual(["outer", "inner"]));
    // Each stays marked until the list drops it, never back to a normal card
    // (this fake server keeps listing them).
    await waitFor(() => expect(screen.getAllByText("Deleting…")).toHaveLength(2));
  });

  it("picks a library by clicking anywhere on its card, but not on its links", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter>
            <LibrariesPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    const box = screen.getByLabelText("Select Other") as HTMLInputElement;
    fireEvent.click(screen.getByText("/photos")); // the path line: plain card
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByText("/photos"));
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "More actions for Other" }));
    expect(box.checked).toBe(false);
  });
});
