import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTags,
  setQuarantine,
  setRating,
  setScore,
} from "./imageMutations";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown = {}) {
  const spy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const JSON_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
};

describe("per-image mutations", () => {
  it.each([
    ["setRating", () => setRating("L1:a.jpg", "explicit"), "rating", { rating: "explicit" }],
    ["setScore", () => setScore("L1:a.jpg", 4), "score", { score: 4 }],
    [
      "setQuarantine",
      () => setQuarantine("L1:a.jpg", true),
      "quarantine",
      { quarantined: true },
    ],
  ])("%s posts to /%s with its body", async (_n, call, suffix, body) => {
    const spy = mockFetch();
    await call();
    expect(spy).toHaveBeenCalledWith(`/api/v1/images/L1%3Aa.jpg/${suffix}`, {
      ...JSON_POST,
      body: JSON.stringify(body),
    });
  });

  it("encodes ids containing slashes and colons", async () => {
    // Image ids are `{library}:{relative/path}`; both characters are live.
    const spy = mockFetch();
    await setScore("L1:sub/dir/a.jpg", 1);
    expect(spy.mock.calls[0][0]).toBe("/api/v1/images/L1%3Asub%2Fdir%2Fa.jpg/score");
  });

  it("applyTags posts the bare tag array", async () => {
    const spy = mockFetch();
    await applyTags("L1:a.jpg", ["cat", "dog"]);
    expect(spy).toHaveBeenCalledWith("/api/v1/tags/apply/L1%3Aa.jpg", {
      ...JSON_POST,
      body: JSON.stringify(["cat", "dog"]),
    });
  });

  it("setRating resolves to the rating the server stored", async () => {
    // Unrated hands the rating back to the AI tagger's pick.
    mockFetch({ _id: "L1:a.jpg", rating: "sensitive" });
    await expect(setRating("L1:a.jpg", "-")).resolves.toBe("sensitive");
    mockFetch({});
    await expect(setRating("L1:a.jpg", "general")).resolves.toBe("general");
  });

  it("throws the response body on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(setRating("nope", "general")).rejects.toThrow("not found");
  });
});
