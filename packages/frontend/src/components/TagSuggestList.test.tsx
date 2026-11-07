import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagSuggestList } from "./TagSuggestList";

const matches = Array.from({ length: 20 }, (_, i) => ({ _id: `tag_${i}`, count: 1 }));

describe("TagSuggestList", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls the active row into view as the arrows move it", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = { matches, onActive: () => {}, onPick: () => {} };
    const { rerender } = render(<TagSuggestList {...props} active={0} />);
    scrolled.mockClear();
    rerender(<TagSuggestList {...props} active={12} />);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(screen.getAllByRole("option")[12]);
  });

  it("leaves the list still when the pointer picks the row", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    const onActive = vi.fn();
    const props = { matches, onActive, onPick: () => {} };
    const { rerender } = render(<TagSuggestList {...props} active={0} />);
    scrolled.mockClear();
    fireEvent.mouseEnter(screen.getAllByRole("button")[7]);
    expect(onActive).toHaveBeenCalledWith(7);
    rerender(<TagSuggestList {...props} active={7} />);
    expect(scrolled).not.toHaveBeenCalled();
  });
});
