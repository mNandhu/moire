import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, errorText, httpError } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
});

const failWith = (body: string, status: number, statusText = "") =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, statusText })),
  );

describe("api", () => {
  it("parses JSON on a 2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })),
    );
    await expect(api<{ ok: number }>("/x")).resolves.toEqual({ ok: 1 });
  });

  it("throws an ApiError carrying the status and the unwrapped detail", async () => {
    failWith(JSON.stringify({ detail: "Image not found" }), 404);
    const e = (await api("/x").catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("Image not found");
    expect(e.status).toBe(404);
  });

  it("joins a 422 detail list by each msg", async () => {
    failWith(
      JSON.stringify({ detail: [{ msg: "field required" }, { msg: "too short" }] }),
      422,
    );
    await expect(api("/x")).rejects.toThrow("field required; too short");
  });

  it("uses a plain-text body as the message", async () => {
    failWith("boom", 500);
    const e = (await api("/x").catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("boom");
    expect(e.status).toBe(500);
  });

  it("falls back to the status line on an empty body", async () => {
    failWith("", 502, "Bad Gateway");
    await expect(api("/x")).rejects.toThrow("502 Bad Gateway");
  });

  it("forwards the init (method/body) to fetch", async () => {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await api("/x", { method: "POST", body: "{}" });
    expect(spy).toHaveBeenCalledWith("/x", { method: "POST", body: "{}" });
  });
});

describe("httpError", () => {
  it("builds the same error from a non-ok Response", async () => {
    const e = await httpError(
      new Response(JSON.stringify({ detail: "nope" }), { status: 409 }),
    );
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("nope");
    expect(e.status).toBe(409);
  });
});

describe("errorText", () => {
  it("still unwraps a JSON message from a plain Error", () => {
    expect(errorText(new Error('{"detail":"old"}'))).toBe("old");
  });

  it("passes an ApiError message through", () => {
    expect(errorText(new ApiError("clean", 400))).toBe("clean");
  });
});
