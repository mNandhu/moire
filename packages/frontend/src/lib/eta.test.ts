import { describe, expect, it } from "vitest";
import { batchLeft, leftLabel, queueTitle, runProgress } from "./eta";
import { clockText, etaLabel, etaShort, roundEta } from "./format";

describe("roundEta", () => {
  it("rounds to 5s under a minute, 10s under ten, else the minute", () => {
    expect(roundEta(0)).toBe(5);
    expect(roundEta(43)).toBe(45);
    expect(roundEta(61)).toBe(60);
    expect(roundEta(154)).toBe(150);
    expect(roundEta(599)).toBe(600);
    expect(roundEta(14 * 60 + 29)).toBe(14 * 60);
  });
});

describe("etaShort / etaLabel", () => {
  it("reads like a person would say it", () => {
    expect(etaShort(44)).toBe("45s");
    expect(etaShort(150)).toBe("2m 30s");
    expect(etaShort(120)).toBe("2m");
    expect(etaShort(14 * 60 + 10)).toBe("14m");
    expect(etaShort(80 * 60)).toBe("1h 20m");
    expect(etaShort(120 * 60)).toBe("2h");
    expect(etaLabel(150)).toBe("about 2m 30s");
  });
});

describe("runProgress", () => {
  it("fills with the time, never full, and counts past the estimate", () => {
    expect(runProgress(20, 5)).toEqual({ fill: 0.25, left: 15, over: 0, phase: "on-time" });
    expect(runProgress(20, 22)).toEqual({ fill: 0.95, left: 0, over: 2, phase: "finishing" });
    expect(runProgress(20, 27)).toEqual({ fill: 0.95, left: 0, over: 7, phase: "late" });
    expect(runProgress(20, null)).toEqual({ fill: 0, left: 20, over: 0, phase: "on-time" });
  });

  it("needs an estimate", () => {
    expect(runProgress(null, 3)).toBeNull();
    expect(runProgress(0, 3)).toBeNull();
  });
});

describe("clockText", () => {
  it("reads to the second", () => {
    expect(clockText(7.9)).toBe("0:07");
    expect(clockText(150)).toBe("2:30");
    expect(clockText(3723)).toBe("1:02:03");
    expect(clockText(-4)).toBe("0:00");
  });
});

describe("batchLeft", () => {
  it("counts what's left of the running request and all of the waiting ones", () => {
    const left = batchLeft([
      { state: "done", expected: null, elapsed: null },
      { state: "running", expected: 10, elapsed: 4 },
      { state: "pending", expected: 10, elapsed: null },
    ]);
    expect(left).toEqual({ seconds: 16, over: false });
  });

  it("is null when a request has no estimate or nothing is left", () => {
    expect(batchLeft([{ state: "pending", expected: null, elapsed: null }])).toBeNull();
    expect(batchLeft([{ state: "done", expected: 10, elapsed: null }])).toBeNull();
  });

  it("says so when the running request overruns", () => {
    const left = batchLeft([{ state: "running", expected: 10, elapsed: 14 }])!;
    expect(left).toEqual({ seconds: 0, over: true });
    expect(leftLabel(left)).toBe("Taking longer than usual");
    expect(leftLabel({ seconds: 150, over: false })).toBe("about 2m 30s left");
    // Past the estimate, not yet an overrun.
    expect(leftLabel({ seconds: 0, over: false })).toBe("Almost done");
  });
});

describe("queueTitle", () => {
  const e = { seconds: 70, load: 20, ahead: 118, basis: "exact" as const, samples: 8 };

  it("words the next batch's time and the queue ahead", () => {
    expect(queueTitle(e)).toBe("Should take about 1m 10s, after about 2m already queued");
  });

  it("leaves out what doesn't apply", () => {
    const plain = { ...e, load: null, ahead: 0, basis: "generator" as const };
    expect(queueTitle(plain)).toBe("Should take about 1m 10s");
  });

  it("says nothing before there are runs to go on", () => {
    const none = { seconds: null, load: null, ahead: 0, basis: null, samples: 0 };
    expect(queueTitle(none)).toBeUndefined();
  });
});
