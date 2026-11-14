import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { RecentImages } from "./RecentImages";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecentImages", () => {
  it("offers Generate when there are no images yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <RecentImages />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("No images yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Generate/ })).toHaveAttribute("href", "/generate");
  });
});
