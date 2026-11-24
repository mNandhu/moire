import { describe, it, expect } from "vitest";
import { addDays, addMonths, monthGrid, sameDay, startOfDay } from "./dates";

describe("dates", () => {
  it("moves by local days", () => {
    expect(addDays(new Date(2026, 10, 30), 1)).toEqual(new Date(2026, 11, 1));
    expect(startOfDay(new Date(2026, 10, 25, 15, 30))).toEqual(new Date(2026, 10, 25));
    expect(sameDay(new Date(2026, 10, 25, 1), new Date(2026, 10, 25, 23))).toBe(true);
  });

  it("moves by months, keeping the day where the month has it", () => {
    expect(addMonths(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28));
    expect(addMonths(new Date(2026, 2, 31), -1)).toEqual(new Date(2026, 1, 28));
    expect(addMonths(new Date(2026, 10, 15), 1)).toEqual(new Date(2026, 11, 15));
  });

  it("lays a month out in six Monday-first weeks", () => {
    const grid = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual(new Date(2026, 9, 26)); // Monday Oct 26
    expect(grid[6]).toEqual(new Date(2026, 10, 1));
  });
});
