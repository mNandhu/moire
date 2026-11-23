import { Component, Suspense, type ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preloadablePage } from "./lazyPage";

function Hello({ name }: { name: string }) {
  return <p>hello {name}</p>;
}

class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>failed</p> : this.props.children;
  }
}

function mount(Page: (p: { name: string }) => ReactNode) {
  return render(
    <Catch>
      <Suspense fallback={<p>loading</p>}>
        <Page name="Ann" />
      </Suspense>
    </Catch>,
  );
}

describe("preloadablePage", () => {
  // Offline: lazyPage shows a failed load instead of reloading the tab.
  beforeEach(() => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders a preloaded page at once, with its props", async () => {
    const { Page, preload } = preloadablePage(() => Promise.resolve({ default: Hello }));
    await preload();
    mount(Page);
    expect(screen.getByText("hello Ann")).toBeInTheDocument();
  });

  it("tries again on the next mount after a failed load", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({ default: Hello });
    const { Page } = preloadablePage(load);
    const first = mount(Page);
    expect(await screen.findByText("failed")).toBeInTheDocument();
    first.unmount();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    await act(async () => {
      mount(Page);
    });
    vi.useRealTimers();
    expect(await screen.findByText("hello Ann")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed preload", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("chunk"))
      .mockResolvedValue({ default: Hello });
    const { Page, preload } = preloadablePage(load);
    await expect(preload()).rejects.toThrow("chunk");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 1000);
    await act(async () => {
      mount(Page);
    });
    vi.useRealTimers();
    expect(await screen.findByText("hello Ann")).toBeInTheDocument();
  });

  it("shows a failed load rather than fetching again at once", async () => {
    const load = vi.fn().mockRejectedValue(new Error("chunk"));
    const { Page } = preloadablePage(load);
    mount(Page);
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
