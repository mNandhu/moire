import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { LatestSession } from "./LatestSession";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LatestSession", () => {
  it("offers Add library and Generate when there are no images yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <LatestSession session={undefined} pending={false} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add library/ })).toHaveAttribute("href", "/libraries");
    expect(screen.getByRole("link", { name: /Generate/ })).toHaveAttribute("href", "/generate");
  });
});
