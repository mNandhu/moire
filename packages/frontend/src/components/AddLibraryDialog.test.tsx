import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddLibraryDialog } from "./AddLibraryDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const cand = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  name: path.split("/").pop(),
  source: "/lib",
  image_count: 2,
  count_capped: false,
  hidden: false,
  status: "new",
  note: null,
  conflict_path: null,
  ...over,
});

const SOURCES = [
  {
    path: "/lib",
    ok: true,
    error: null,
    subdir_count: 3,
    loose_image_count: 0,
    fell_back_to_root: false,
    candidates: [
      cand("/lib/a"),
      cand("/lib/b"),
      cand("/lib/old", { status: "registered", note: "Already a library" }),
    ],
  },
];

function mockFetch(failPaths: string[] = []) {
  const posts: { path: string; name?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/libraries/discover")) {
        return new Response(JSON.stringify({ sources: SOURCES }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      if (failPaths.includes(body.path)) {
        return new Response(JSON.stringify({ detail: "boom" }), { status: 400 });
      }
      return new Response(JSON.stringify({ _id: "x", ...body }), { status: 200 });
    }),
  );
  return posts;
}

async function previewFlow() {
  fireEvent.change(screen.getByLabelText("Folders"), { target: { value: "/lib" } });
  fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
  await screen.findByDisplayValue("a");
}

afterEach(() => vi.unstubAllGlobals());

describe("AddLibraryDialog", () => {
  it("adds only the ticked rows, with edited names", async () => {
    const posts = mockFetch();
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={onAdded} />, { wrapper });
    await previewFlow();

    // Registered row can't be ticked; untick b; rename a.
    fireEvent.click(screen.getAllByRole("checkbox")[2]);
    fireEvent.change(screen.getByDisplayValue("a"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /Add 1 library/ }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ added: 1, failed: [] }));
    expect(posts).toEqual([{ path: "/lib/a", name: "Alpha" }]);
    expect(onClose).toHaveBeenCalled();
  });

  it("Ctrl+Enter can't start a second add or add an empty selection", async () => {
    const posts = mockFetch();
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={vi.fn()} />, { wrapper });
    await previewFlow();
    const box = screen.getByLabelText("Folders");

    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts.map((p) => p.path)).toEqual(["/lib/a", "/lib/b"]);
  });

  it("Ctrl+Enter with nothing ticked keeps the dialog open", async () => {
    const posts = mockFetch();
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={vi.fn()} />, { wrapper });
    await previewFlow();
    // [0] is the split toggle; [1] and [2] are the two new rows.
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getAllByRole("checkbox")[2]);

    fireEvent.keyDown(screen.getByLabelText("Folders"), { key: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps only the failed rows selected after a partial failure", async () => {
    const posts = mockFetch(["/lib/b"]);
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<AddLibraryDialog open onClose={onClose} onAdded={onAdded} />, { wrapper });
    await previewFlow();

    fireEvent.click(screen.getByRole("button", { name: /Add 2 libraries/ }));

    await screen.findByText(/1 failed/);
    expect(onAdded).toHaveBeenCalledWith({ added: 1, failed: ["/lib/b: boom"] });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Add 1 library/ })).toBeTruthy();
    expect(posts.map((p) => p.path)).toEqual(["/lib/a", "/lib/b"]);
  });
});

describe("AddLibraryDialog › closing mid-preview", () => {
  it("drops a preview that lands after the dialog closed", async () => {
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((res) => {
            release = () =>
              res(new Response(JSON.stringify({ sources: SOURCES }), { status: 200 }));
          }),
      ),
    );
    const { rerender } = render(<AddLibraryDialog open onClose={() => {}} onAdded={vi.fn()} />, { wrapper });
    fireEvent.change(screen.getByLabelText("Folders"), { target: { value: "/lib" } });
    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    release();
    await new Promise((r) => setTimeout(r, 0));

    rerender(<AddLibraryDialog open onClose={() => {}} onAdded={vi.fn()} />);
    expect(screen.queryByDisplayValue("a")).toBeNull();
    expect((screen.getByLabelText("Folders") as HTMLTextAreaElement).value).toBe("");
  });
});
