import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ToastProvider } from "./components/Toasts";
import RootRoutes from "./RootRoutes";

// The first-run guard: a fresh install opens on the welcome page, a set-up
// one on the gallery, and a failed check doesn't lock anyone out.

function stubFetch(onboarding: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/v1/onboarding")) {
        return new Response(JSON.stringify(onboarding), { status: ok ? 200 : 500 });
      }
      return new Response("[]", { status: 200 });
    }),
  );
}

const info = (status: string) => ({ status, version: "1.0.0", data_dir: "/data", host: "pc", checkout: false });

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <RootRoutes />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("onboarding route guard", () => {
  it("sends a fresh install to the welcome page", async () => {
    stubFetch(info("pending"));
    renderAt("/");
    expect(await screen.findByRole("button", { name: "Set up Moiré" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy();
    expect(screen.getByTestId("where").textContent).toBe("/welcome");
  });

  it("leaves a set-up install on the page it asked for", async () => {
    stubFetch(info("done"));
    renderAt("/settings");
    // The app shell rendered (its sidebar), and the path stayed.
    expect((await screen.findAllByText("Libraries")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("where").textContent).toBe("/settings");
    expect(screen.queryByRole("button", { name: "Set up Moiré" })).toBeNull();
  });

  it("opens the app when the check fails", async () => {
    stubFetch({ detail: "boom" }, false);
    renderAt("/settings");
    expect((await screen.findAllByText("Libraries")).length).toBeGreaterThan(0);
    expect(screen.getByTestId("where").textContent).toBe("/settings");
  });
});
