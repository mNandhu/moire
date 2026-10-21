import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import WelcomePage from "./WelcomePage";

// Setup's folder step: a path goes in the list only once it checks out, and
// Continue creates exactly the libraries in the list.

type Call = { url: string; method: string; body: unknown };
let calls: Call[];

const source = (path: string, ok = true) => ({
  path,
  ok,
  error: ok ? null : "Not a directory or not reachable",
  subdir_count: 0,
  loose_image_count: 0,
  fell_back_to_root: false,
  candidates: ok
    ? [{ path, name: "output", source: path, image_count: 42, count_capped: false, hidden: false, status: "new", note: null, conflict_path: null }]
    : [],
});

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (url.endsWith("/onboarding")) {
        return json({ status: "pending", version: "1.2.3", data_dir: "/data", host: "pc", checkout: false });
      }
      if (url.endsWith("/libraries/discover")) {
        const p = (body as { paths: string[] }).paths[0];
        return json({ sources: [source(p, !p.includes("missing"))] });
      }
      if (url.endsWith("/libraries") && method === "POST") return json({ _id: "lib1", ...(body as object) });
      if (url.endsWith("/generate/comfyui")) return json({ address: "" });
      return json([]);
    }),
  );
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <WelcomePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const discoverCalls = () => calls.filter((c) => c.url.endsWith("/libraries/discover"));

async function addPath(path: string) {
  const input = screen.getByLabelText("Folder path");
  fireEvent.change(input, { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}

describe("WelcomePage setup", () => {
  it("opens setup from the landing page", async () => {
    renderPage();
    expect(await screen.findByText(/Version 1\.2\.3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up Moiré" }));
    expect(screen.getByRole("heading", { name: "Image folders" })).toBeTruthy();
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Add a folder to continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a relative path in the field without asking the server", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Moiré" }));
    await addPath("ComfyUI\\output");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/full path/));
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("ComfyUI\\output");
    expect(discoverCalls()).toHaveLength(0);
  });

  it("keeps an unreachable folder out of the list", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Moiré" }));
    await addPath("D:\\missing");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/can't open/));
    expect(screen.queryByRole("button", { name: "Remove D:\\missing" })).toBeNull();
  });

  it("lists a good folder and creates its library on Continue", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Moiré" }));
    await addPath('"C:\\ComfyUI\\output"');
    expect(await screen.findByText("42 images")).toBeTruthy();
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("");

    // The same folder again is refused before any request.
    await addPath("c:/comfyui/output/");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/already in the list/));
    expect(discoverCalls()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "ComfyUI" })).toBeTruthy();
    const posts = calls.filter((c) => c.url.endsWith("/libraries") && c.method === "POST");
    expect(posts.map((c) => c.body)).toEqual([{ path: "C:\\ComfyUI\\output", name: "output" }]);

    // Back and Continue again doesn't create it twice.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: "ComfyUI" });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/libraries") && c.method === "POST")).toHaveLength(1),
    );
  });
});
