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
          <LibrariesPage />
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
