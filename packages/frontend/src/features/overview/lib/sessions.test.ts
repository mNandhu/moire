import { describe, it, expect } from "vitest";
import { bestOf, byDay, latestDay, sessionCharacter, sessionContext, sessionSpan, sessionDay, splitSessions } from "./sessions";

const now = new Date(2026, 10, 24, 15, 0); // Tue Nov 24 2026
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime() / 1000;

describe("sessionDay", () => {
  it("names today, yesterday and this week's days", () => {
    expect(sessionDay(at(2026, 10, 24, 0), now)).toBe("Today");
    expect(sessionDay(at(2026, 10, 23, 23), now)).toBe("Yesterday");
    expect(sessionDay(at(2026, 10, 20), now)).toBe("Friday");
  });
  it("dates older days, with the year only when it differs", () => {
    expect(sessionDay(at(2026, 10, 12), now)).toBe("Nov 12");
    expect(sessionDay(at(2025, 11, 30), now)).toBe("Dec 30, 2025");
    expect(sessionDay(null, now)).toBe("Earlier");
  });
});

describe("sessionContext", () => {
  it("dates a session, never Today: it outlives the day", () => {
    const today = { start: at(2026, 10, 24, 10), end: at(2026, 10, 24, 11) };
    expect(sessionContext(today, now)).toMatch(/^Nov 24, \S.* to \S/);
    expect(sessionContext({ start: null, end: at(2025, 11, 30) }, now)).toMatch(/^Dec 30, 2025, /);
    expect(sessionContext({ start: null, end: null }, now)).toBe("Earlier session");
  });
});

describe("byDay", () => {
  it("groups runs of the same day in order", () => {
    const items = [at(2026, 10, 24, 14), at(2026, 10, 24, 9), at(2026, 10, 23), at(2026, 10, 12)].map((mtime) => ({ mtime }));
    expect(byDay(items, (i) => i.mtime, now).map((g) => [g.day, g.items.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Nov 12", 1],
    ]);
  });
});

describe("splitSessions", () => {
  const items = [1000, 900, 100, -5000, -5100].map((t) => ({ mtime: 1_800_000_000 + t }));
  it("cuts where the library went quiet", () => {
    const s = splitSessions(items, true, 600);
    expect(s.map((x) => x.items.length)).toEqual([2, 1, 2]);
    expect(s[0].start).toBe(1_800_000_900);
    expect(s[0].end).toBe(1_800_001_000);
  });
  it("leaves out the oldest when more images may belong to it", () => {
    expect(splitSessions(items, false, 600).map((x) => x.items.length)).toEqual([2, 1]);
    const lone = splitSessions(items.slice(0, 2), false, 600);
    expect(lone).toHaveLength(1);
    expect(lone[0].partial).toBe(true);
    expect(sessionSpan(lone[0])).toMatch(/^until /);
    expect(splitSessions(items, true, 600)[2].partial).toBeUndefined();
  });
});

describe("latestDay", () => {
  it("folds the latest day's sessions into one", () => {
    const s = (h1: number, h2: number, d = 24) => ({ items: [h2, h1], start: at(2026, 10, d, h1), end: at(2026, 10, d, h2) });
    const { latest, earlier } = latestDay([s(18, 19), s(14, 15), s(20, 21, 22)], now);
    expect(latest?.items).toEqual([19, 18, 15, 14]);
    expect(latest?.start).toBe(at(2026, 10, 24, 14));
    expect(latest?.end).toBe(at(2026, 10, 24, 19));
    expect(earlier).toHaveLength(1);
    expect(latestDay([], now).latest).toBeUndefined();
  });
});

describe("bestOf", () => {
  it("takes the top score, else the first (newest)", () => {
    const a = { id: "a", score: null }, b = { id: "b", score: 3 }, c = { id: "c", score: 3 };
    expect(bestOf([a, b, c])?.id).toBe("b");
    expect(bestOf([a, { id: "d", score: null }])?.id).toBe("a");
    expect(bestOf([])).toBeUndefined();
  });
});

describe("sessionCharacter", () => {
  it("names a session for a character in at least half of it", () => {
    expect(sessionCharacter([{ tag: "may", count: 2 }], 38)).toBeUndefined();
    expect(sessionCharacter([{ tag: "yuzuriha", count: 19 }], 38)?.tag).toBe("yuzuriha");
    expect(sessionCharacter([], 38)).toBeUndefined();
    expect(sessionCharacter(undefined, 0)).toBeUndefined();
  });
});
