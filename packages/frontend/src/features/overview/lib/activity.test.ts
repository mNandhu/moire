import { describe, it, expect } from "vitest";
import { countLastDays, weekLabel, weeklyActivity } from "./activity";

// Sunday Oct 18, 2026, local time.
const NOW = new Date(2026, 9, 18, 15);

describe("weeklyActivity", () => {
  it("folds days into Monday-start weeks ending this week, gaps as zeros", () => {
    const weeks = weeklyActivity(
      [
        { day: "2026-10-12", count: 2 }, // Monday of this week
        { day: "2026-10-18", count: 3 }, // today (Sunday), same week
        { day: "2026-09-30", count: 5 }, // three weeks back
        { day: "2024-01-01", count: 9 }, // outside the window
      ],
      NOW,
      4,
    );
    expect(weeks.map((w) => [w.start.getDate(), w.count])).toEqual([
      [21, 0],
      [28, 5],
      [5, 0],
      [12, 5],
    ]);
  });

  it("ticks month starts and the year in January", () => {
    const jan20 = new Date(2026, 0, 20);
    // Weeks of Dec 15, 22, 29, Jan 5, 12, 19.
    expect(weeklyActivity([], jan20, 6).map((w) => w.tick)).toEqual([
      "Dec", null, null, "2026", null, null,
    ]);
    // The first label is dropped when the next one is a week away.
    expect(weeklyActivity([], jan20, 4).map((w) => w.tick)).toEqual([
      null, "2026", null, null,
    ]);
  });
});

describe("countLastDays", () => {
  it("counts today and the n-1 days before it", () => {
    const days = [
      { day: "2026-10-18", count: 1 },
      { day: "2026-09-19", count: 2 },
      { day: "2026-09-18", count: 4 },
    ];
    expect(countLastDays(days, 30, NOW)).toBe(3);
  });
});

describe("weekLabel", () => {
  it("adds the year only when it isn't the current one", () => {
    expect(weekLabel(new Date(2026, 9, 12), NOW)).toBe("Week of Oct 12");
    expect(weekLabel(new Date(2025, 9, 13), NOW)).toBe("Week of Oct 13, 2025");
  });
});
