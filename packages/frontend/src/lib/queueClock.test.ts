import { describe, expect, it } from "vitest";
import { imagesLeft, legClock, queueLegs } from "./queueClock";
import { clockText } from "./format";
import type { ActiveBatch } from "./generate";

const b = (id: number, requests: number, finished: number, eta: number | null): ActiveBatch => ({
  _id: id,
  name: `b${id}`,
  test: false,
  state: "running",
  requests,
  finished,
  failed: 0,
  progress: null,
  eta,
  frames: Array.from({ length: requests }, () => ({ state: "waiting" as const, thumb: null })),
});

describe("queueLegs", () => {
  it("runs legs without server times one after another", () => {
    const { legs, total } = queueLegs([b(1, 4, 0, 60), b(2, 4, 0, 180)]);
    expect(total).toBe(240);
    expect(legs.map((l) => [l.start, l.end])).toEqual([[0, 60], [60, 240]]);
  });
  it("guesses a batch with no estimate from the others", () => {
    const { legs } = queueLegs([b(1, 4, 0, 40), b(2, 2, 0, null)]);
    expect(legs[1]).toMatchObject({ guess: true, seconds: 20, start: 40, end: 60 });
  });
  it("uses the server's turn-taking times and leads with the running batch", () => {
    const { legs, total } = queueLegs([
      { ...b(1, 2, 0, 40), starts_in: 10, done_in: 90 },
      { ...b(2, 2, 0, 40), starts_in: 0, done_in: 70, running: true },
    ]);
    expect(legs.map((l) => l.id)).toEqual([2, 1]);
    expect(legs[1]).toMatchObject({ start: 10, end: 90, guess: false });
    expect(total).toBe(90);
  });
});

describe("queueLegs without server times", () => {
  it("starts the running batch now even when it isn't listed first", () => {
    const { legs } = queueLegs([b(1, 2, 0, 60), { ...b(2, 2, 0, 30), running: true }]);
    expect(legs.map((l) => [l.id, l.start, l.end])).toEqual([[2, 0, 30], [1, 30, 90]]);
    expect(legs[1].guess).toBe(false);
  });
});

describe("imagesLeft", () => {
  it("counts the server's per-image frames still waiting or being made", () => {
    const making = { state: "making" as const, thumb: null };
    const done = { state: "done" as const, thumb: "/t" };
    const { legs } = queueLegs([{ ...b(1, 2, 1, 30), frames: [done, done, making, making] }, b(2, 3, 0, 30)]);
    expect(imagesLeft(legs)).toBe(5);
  });
});

describe("legClock", () => {
  it("runs a leg's start and end down to zero", () => {
    const { legs } = queueLegs([b(1, 1, 0, 60), b(2, 1, 0, 30)]);
    expect(legClock(legs[1], 20)).toEqual({ startsIn: 40, left: 70 });
    expect(legClock(legs[1], 100)).toEqual({ startsIn: 0, left: 0 });
  });
});

describe("clockText round", () => {
  it("reads like a timer", () => {
    expect(clockText(5, "round")).toBe("0:05");
    expect(clockText(545, "round")).toBe("9:05");
    expect(clockText(3729, "round")).toBe("1:02:09");
    expect(clockText(-3, "round")).toBe("0:00");
  });
});
