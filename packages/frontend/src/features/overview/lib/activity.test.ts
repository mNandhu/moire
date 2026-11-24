import { describe, it, expect } from "vitest";
import { activityCalendar, busiestDay, countLastDays, currentStreak } from "./activity";

// Sunday Oct 18, 2026, local time.
const NOW = new Date(2026, 9, 18, 15);

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

describe("activityCalendar", () => {
  const now = new Date(2026, 10, 25); // Wed Nov 25 2026
  it("ends with the current week, Monday first, future days empty", () => {
    const cal = activityCalendar([], now, 2);
    expect(cal).toHaveLength(2);
    expect(cal[1][0]?.date).toEqual(new Date(2026, 10, 23));
    expect(cal[1][2]?.date).toEqual(new Date(2026, 10, 25));
    expect(cal[1][3]).toBeNull();
  });
  it("levels days by quarter of the busy days, so one big day doesn't flatten the rest", () => {
    const days = [
      { day: "2026-11-16", count: 1 },
      { day: "2026-11-17", count: 2 },
      { day: "2026-11-18", count: 3 },
      { day: "2026-11-19", count: 500 },
    ];
    const cal = activityCalendar(days, now, 2);
    expect(cal[0].map((c) => c?.level)).toEqual([1, 2, 3, 4, 0, 0, 0]);
  });
  it("lights a lone busy day, or days all alike, fully", () => {
    expect(activityCalendar([{ day: "2026-11-18", count: 50 }], now, 2)[0][2]?.level).toBe(4);
    const alike = activityCalendar([{ day: "2026-11-16", count: 5 }, { day: "2026-11-17", count: 5 }], now, 2);
    expect(alike[0].slice(0, 2).map((c) => c?.level)).toEqual([4, 4]);
  });
});

describe("currentStreak", () => {
  const now = new Date(2026, 10, 25, 9);
  it("counts back from today, or from yesterday before today has any", () => {
    const days = [
      { day: "2026-11-22", count: 1 },
      { day: "2026-11-23", count: 4 },
      { day: "2026-11-24", count: 2 },
    ];
    expect(currentStreak(days, now)).toBe(3);
    expect(currentStreak([...days, { day: "2026-11-25", count: 1 }], now)).toBe(4);
    expect(currentStreak([{ day: "2026-11-20", count: 1 }], now)).toBe(0);
  });
});

describe("busiestDay", () => {
  it("picks the largest day", () => {
    expect(busiestDay([{ day: "2026-11-01", count: 3 }, { day: "2026-11-02", count: 9 }])?.count).toBe(9);
    expect(busiestDay([])).toBeNull();
  });
});
