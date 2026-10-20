import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { setTitlePrefix, useDocumentTitle } from "./useDocumentTitle";

afterEach(() => {
  setTitlePrefix("");
  document.title = "";
});

describe("useDocumentTitle", () => {
  it("names the tab after the page", () => {
    document.title = "Moiré";
    renderHook(() => useDocumentTitle("Libraries"));
    expect(document.title).toBe("Libraries · Moiré");
  });

  it("restores the previous title on unmount (overlay closes)", () => {
    document.title = "All Images · Moiré";
    const { unmount } = renderHook(() => useDocumentTitle("cat.png"));
    expect(document.title).toBe("cat.png · Moiré");
    unmount();
    expect(document.title).toBe("All Images · Moiré");
  });

  it("follows title changes and ignores an empty title", () => {
    document.title = "Moiré";
    const { rerender } = renderHook(({ t }) => useDocumentTitle(t), {
      initialProps: { t: "All Images" as string | undefined },
    });
    rerender({ t: "Filtered Images" });
    expect(document.title).toBe("Filtered Images · Moiré");
    rerender({ t: undefined });
    expect(document.title).toBe("Moiré");
  });

  it("keeps a prefix in front as pages come and go", () => {
    document.title = "Moiré";
    setTitlePrefix("2m left · ");
    expect(document.title).toBe("2m left · Moiré");
    const { unmount } = renderHook(() => useDocumentTitle("Generate"));
    expect(document.title).toBe("2m left · Generate · Moiré");
    setTitlePrefix("1m left · ");
    expect(document.title).toBe("1m left · Generate · Moiré");
    unmount();
    expect(document.title).toBe("1m left · Moiré");
    setTitlePrefix("");
    expect(document.title).toBe("Moiré");
  });
});
