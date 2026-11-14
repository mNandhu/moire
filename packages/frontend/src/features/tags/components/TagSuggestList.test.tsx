import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TagSuggestList } from "./TagSuggestList";

const matches = Array.from({ length: 20 }, (_, i) => ({ _id: `tag_${i}`, count: 1 }));
const ROW = 30;

/** jsdom has no layout: rows ROW tall, the list three rows high. */
function layOut() {
  const list = screen.getByRole("listbox");
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 3 * ROW });
  list.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  screen.getAllByRole("option").forEach((row, i) => {
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: ROW });
    row.getBoundingClientRect = () => ({ top: i * ROW - list.scrollTop }) as DOMRect;
  });
  return list;
}

describe("TagSuggestList", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls the list (not the page) to the row the arrows move to", () => {
    const page = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = { matches, onActive: () => {}, onPick: () => {} };
    const { rerender } = render(<TagSuggestList {...props} active={0} />);
    const list = layOut();
    rerender(<TagSuggestList {...props} active={12} />);
    expect(list.scrollTop).toBe(13 * ROW - 3 * ROW);
    rerender(<TagSuggestList {...props} active={2} />);
    expect(list.scrollTop).toBe(2 * ROW);
    expect(page).not.toHaveBeenCalled();
  });

  it("leaves the list still when the pointer picks the row, and the next arrow still scrolls", () => {
    const onActive = vi.fn();
    const props = { matches, onActive, onPick: () => {} };
    const { rerender } = render(<TagSuggestList {...props} active={0} />);
    const list = layOut();
    list.scrollTop = 2 * ROW;
    fireEvent.mouseEnter(screen.getAllByRole("button")[4]);
    expect(onActive).toHaveBeenCalledWith(4);
    rerender(<TagSuggestList {...props} active={4} />);
    expect(list.scrollTop).toBe(2 * ROW);
    rerender(<TagSuggestList {...props} active={5} />);
    expect(list.scrollTop).toBe(3 * ROW);
  });

  it("stays where the wheel put it when the same rows come again", () => {
    const props = { onActive: () => {}, onPick: () => {} };
    const { rerender } = render(<TagSuggestList {...props} matches={matches} active={0} />);
    const list = layOut();
    list.scrollTop = 5 * ROW;
    rerender(<TagSuggestList {...props} matches={[...matches]} active={0} />);
    expect(list.scrollTop).toBe(5 * ROW);
  });
});
