import { describe, expect, it } from "vitest";
import { scanProblem, type Library } from "./queries";

const lib = (scan_error: string | null, scanning = false): Library =>
  ({ _id: "L", name: "L", path: "/p", scan_error, scanning }) as Library;

describe("scanProblem", () => {
  it("is a failure for an error, a note for what a finished scan kept", () => {
    expect(scanProblem(lib("Library folder not found: /p"))).toEqual({
      text: "Library folder not found: /p",
      note: false,
    });
    expect(scanProblem(lib("Kept 40 images: folder unreadable"))?.note).toBe(true);
    expect(scanProblem(lib("Some folders could not be read; their images were kept"))?.note).toBe(true);
  });
  it("is nothing while scanning, after a cancel, or when clean", () => {
    expect(scanProblem(lib("boom", true))).toBeNull();
    expect(scanProblem(lib("cancelled"))).toBeNull();
    expect(scanProblem(lib(null))).toBeNull();
  });
});
