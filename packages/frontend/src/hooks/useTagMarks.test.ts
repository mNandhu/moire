import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { setTagMarks, TAG_MARKS_DEFAULT, useTagMarks } from "./useTagMarks";

afterEach(() => {
  setTagMarks(TAG_MARKS_DEFAULT);
  localStorage.clear();
});

describe("useTagMarks", () => {
  it("starts with both marks on and follows changes", () => {
    const { result } = renderHook(() => useTagMarks());
    expect(result.current).toEqual({ outlines: true, tints: true });
    act(() => setTagMarks({ outlines: false }));
    expect(result.current).toEqual({ outlines: false, tints: true });
    expect(JSON.parse(localStorage.getItem("tags:marks")!)).toEqual({ outlines: false, tints: true });
  });
});
