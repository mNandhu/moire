import { describe, expect, it } from "vitest";

// A thumbnail URL is versioned by the server; one built here from an id has
// no version, and an old cached copy of it can stay on screen.
const BUILT = /images\/\$\{[^}]*\}\/thumb(?!-url)/;

const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("thumbnail URLs", () => {
  it("are never built from an image id", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(Object.keys(sources).filter((p) => BUILT.test(sources[p]))).toEqual([]);
  });
});
