import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiJson, apiRaw, errorText, httpError, jsonInit } from "./api";

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

describe("jsonInit", () => {
  it("stringifies the body and sets the JSON Content-Type", () => {
    const init = jsonInit("PUT", { a: 1 });
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("sends no body and no Content-Type without one", () => {
    expect(jsonInit("DELETE")).toEqual({ method: "DELETE" });
  });

  it("keeps the rest of the init (a signal) and its headers", () => {
    const signal = new AbortController().signal;
    const init = jsonInit("POST", [1], { signal, headers: { "X-Test": "y" } });
    expect(init.signal).toBe(signal);
    expect(new Headers(init.headers).get("X-Test")).toBe("y");
    expect(init.body).toBe("[1]");
  });

  it("sends a falsy body (null, 0) as JSON", () => {
    expect(jsonInit("POST", null).body).toBe("null");
    expect(jsonInit("POST", 0).body).toBe("0");
  });
});

describe("apiJson", () => {
  it("sends the JSON body and parses the reply", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", spy);
    await expect(apiJson("/x", "POST", { n: 2 })).resolves.toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/x");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"n":2}');
  });

  it("throws the same ApiError as api on non-2xx", async () => {
    failWith(JSON.stringify({ detail: "bad" }), 400);
    const e = (await apiJson("/x", "PUT", {}).catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("bad");
  });
});

describe("apiRaw", () => {
  it("returns the Response so a header can be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200, headers: { "X-Next-Cursor": "c1" } })),
    );
    const r = await apiRaw("/x");
    expect(r.headers.get("X-Next-Cursor")).toBe("c1");
  });

  it("throws on non-2xx", async () => {
    failWith("nope", 404);
    await expect(apiRaw("/x")).rejects.toBeInstanceOf(ApiError);
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
