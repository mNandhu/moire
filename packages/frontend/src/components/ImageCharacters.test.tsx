import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "./Toasts";
import { ImageCharacters } from "./ImageCharacters";

const alice = {
  tag: "alice",
  aliases: [],
  count: 3,
  thumb_url: "/t.webp",
  thumb_image_id: "lib:other.png",
  name: null,
  series: null,
  color: null,
  focus: null,
  face: null,
  aspect: null,
};

describe("ImageCharacters › setting an avatar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the avatar as updating until the change is in", async () => {
    let answer!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          // The server crops the new avatar before it answers.
          await new Promise<void>((r) => (answer = r));
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify([alice]), { status: 200 });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <MemoryRouter>
            <ImageCharacters imageId="lib:this.png" tags={["alice"]} />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    const pin = await screen.findByRole("button", { name: "Use as alice's avatar" });
    fireEvent.click(pin);
    await waitFor(() => expect(pin).toHaveAttribute("aria-busy", "true"));
    expect(pin).toHaveAttribute("title", "Updating…");

    answer();
    await waitFor(() => expect(pin).toHaveAttribute("aria-busy", "false"));
  });
});
