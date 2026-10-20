import { describe, it, expect } from "vitest";
import { describeTask, endedKinds, startedKinds, taskPct, type BackgroundTask } from "./backgroundTasks";

const names = (id: string) => ({ A: "sdxl" })[id];

describe("describeTask", () => {
  it("words a scan by its library, waiting until it has counted files", () => {
    expect(describeTask({ key: "s", kind: "scan", library_id: "A", done: 0, total: null }, names)).toEqual({
      title: "Scanning sdxl",
      detail: "Waiting to start",
      pct: null,
    });
    expect(describeTask({ key: "s", kind: "scan", library_id: "A", done: 25, total: 100 }, names)).toEqual({
      title: "Scanning sdxl",
      detail: "25 of 100 files",
      pct: 25,
    });
  });

  it("counts a download in MB", () => {
    const t: BackgroundTask = { key: "d", kind: "model_download", unit: "bytes", done: 50 * 1024 * 1024, total: 200 * 1024 * 1024 };
    expect(describeTask(t)).toMatchObject({ detail: "50 of 200 MB", pct: 25 });
  });

  it("tells an AI job waiting on the model from one tagging", () => {
    expect(describeTask({ key: "a", kind: "ai_job", phase: "model", done: 0, total: 1 }).detail).toBe(
      "Waiting for the model",
    );
    expect(describeTask({ key: "a", kind: "ai_job", phase: "tagging", status: "running", done: 1, total: 4 }).detail).toBe(
      "1 of 4 images",
    );
    expect(describeTask({ key: "a", kind: "ai_job", status: "running", done: 10, total: 100, eta_s: 180 }).detail).toBe(
      "10 of 100 images · 3 min left",
    );
  });

  it("names an unknown library generically", () => {
    expect(describeTask({ key: "x", kind: "delete", library_id: "Z" }, names).title).toBe("Deleting a library");
  });
});

it("never reads past 100%", () => {
  expect(taskPct({ done: 12, total: 10 })).toBe(100);
  expect(taskPct({ done: 1, total: 0 })).toBeNull();
});

it("finds work that ended, even work no poll saw running", () => {
  expect([...endedKinds({ scan: 2, ai_job: 1 }, { scan: 2, ai_job: 2 })]).toEqual(["ai_job"]);
  expect([...endedKinds({}, { delete: 1 })]).toEqual(["delete"]);
  expect(endedKinds({ scan: 1 }, { scan: 1 }).size).toBe(0);
  // A restarted server counts from zero again.
  expect([...endedKinds({ scan: 5 }, { scan: 0 })]).toEqual(["scan"]);
});

it("finds the kinds of work that just started", () => {
  const a = { key: "scan:A", kind: "scan" };
  const b = { key: "ai:1", kind: "ai_job" };
  expect([...startedKinds([a], [a, b])]).toEqual(["ai_job"]);
  expect(startedKinds([a, b], [a]).size).toBe(0);
});
