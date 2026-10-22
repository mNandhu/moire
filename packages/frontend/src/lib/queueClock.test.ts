import { describe, expect, it } from "vitest";
import { countdown, legClock, queueLegs } from "./queueClock";
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

describe("legClock", () => {
  it("runs a leg's start and end down to zero", () => {
    const { legs } = queueLegs([b(1, 1, 0, 60), b(2, 1, 0, 30)]);
    expect(legClock(legs[1], 20)).toEqual({ startsIn: 40, left: 70 });
    expect(legClock(legs[1], 100)).toEqual({ startsIn: 0, left: 0 });
  });
});

describe("countdown", () => {
  it("reads like a timer", () => {
    expect(countdown(5)).toBe("0:05");
    expect(countdown(545)).toBe("9:05");
    expect(countdown(3729)).toBe("1:02:09");
    expect(countdown(-3)).toBe("0:00");
  });
});
