import { afterEach, describe, it, expect, vi } from "vitest";
import {
  aiJobLabel,
  fetchAiCoverage,
  isTerminalJob,
  isActiveJob,
  isStatusBusy,
  coveragePct,
  formatDuration,
  formatRate,
  jobAgo,
  jobThroughput,
  libraryCoverageRows,
  jobStatusLabel,
  postAiJobCancel,
  postAiTag,
  postClearAiTags,
  postModelDownloadCancel,
  postModelLoad,
  postModelLoadCancel,
  postModelUnload,
  postTagUntagged,
  saveAiSettings,
  type AIStatus,
} from "./ai";

describe("isTerminalJob", () => {
  it.each(["done", "error", "cancelled"])("is terminal: %s", (s) => {
    expect(isTerminalJob(s)).toBe(true);
  });
  it.each(["queued", "running", "cancelling", "unknown", undefined, null])(
    "is not terminal: %s",
    (s) => {
      expect(isTerminalJob(s)).toBe(false);
    },
  );
});

describe("isActiveJob", () => {
  it.each(["queued", "running", "cancelling"])("is active: %s", (s) => {
    expect(isActiveJob(s)).toBe(true);
  });
  it.each(["done", "error", "cancelled", undefined])(
    "is not active: %s",
    (s) => {
      expect(isActiveJob(s)).toBe(false);
    },
  );
});

describe("isStatusBusy", () => {
  const base: AIStatus = {
    model: { loaded: false },
    jobs: { recent: [], queue_depth: 0 },
    settings: {} as AIStatus["settings"],
  };

  it("is idle for null/empty status", () => {
    expect(isStatusBusy(null)).toBe(false);
    expect(isStatusBusy(base)).toBe(false);
  });

  it("is busy while the model is loading", () => {
    expect(isStatusBusy({ ...base, model_load: { status: "loading" } })).toBe(
      true,
    );
  });

  it("is busy while the model is downloading", () => {
    expect(
      isStatusBusy({ ...base, model_download: { status: "downloading" } }),
    ).toBe(true);
  });

  it("is busy while a recent job is active", () => {
    const job = {
      id: "j1",
      created_at: 0,
      status: "running",
      total: 1,
      done: 0,
      failed: 0,
    };
    expect(
      isStatusBusy({ ...base, jobs: { recent: [job], queue_depth: 0 } }),
    ).toBe(true);
  });

  it("is idle when recent jobs are all terminal", () => {
    const job = {
      id: "j1",
      created_at: 0,
      status: "done",
      total: 1,
      done: 1,
      failed: 0,
    };
    expect(
      isStatusBusy({ ...base, jobs: { recent: [job], queue_depth: 0 } }),
    ).toBe(false);
  });
});

// --- Commands ---------------------------------------------------------------
//
// These six endpoints previously existed only inside SettingsContext, so
// "does cancel-download hit the right URL" needed renderHook + a provider + a
// fetch mock. As adapters they are the same shape of test as api.test.ts.

describe("AI commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(body: unknown = {}) {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(body), { status: 200 }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it.each([
    ["postModelLoad", () => postModelLoad(), "/api/v1/ai/model/load"],
    ["postModelLoadCancel", () => postModelLoadCancel(), "/api/v1/ai/model/load-cancel"],
    [
      "postModelDownloadCancel",
      () => postModelDownloadCancel(),
      "/api/v1/ai/model/download-cancel",
    ],
    ["postModelUnload", () => postModelUnload(), "/api/v1/ai/model/unload"],
    ["postClearAiTags", () => postClearAiTags(), "/api/v1/ai/clear-ai-tags"],
  ])("%s POSTs %s", async (_name, call, url) => {
    const spy = mockFetch();
    await call();
    expect(spy).toHaveBeenCalledWith(url, { method: "POST" });
  });

  it("postAiJobCancel encodes the job id into the path", async () => {
    const spy = mockFetch({ ok: true });
    await postAiJobCancel("job/1");
    expect(spy).toHaveBeenCalledWith("/api/v1/ai/jobs/job%2F1/cancel", {
      method: "POST",
    });
  });

  it("postAiTag sends the ids as a JSON body", async () => {
    const spy = mockFetch({ job_id: "j1" });
    await expect(postAiTag(["a", "b"])).resolves.toEqual({ job_id: "j1" });
    expect(spy).toHaveBeenCalledWith("/api/v1/ai/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"] }),
    });
  });

  it("postTagUntagged sends the limit", async () => {
    const spy = mockFetch({ job_id: null, queued: 0 });
    await postTagUntagged(50);
    expect(spy.mock.calls[0][1]).toMatchObject({
      body: JSON.stringify({ limit: 50 }),
    });
  });

  it("postTagUntagged names the library when given one", async () => {
    const spy = mockFetch({ job_id: null, queued: 0 });
    await postTagUntagged(50, "lib1");
    expect(spy.mock.calls[0][1]).toMatchObject({
      body: JSON.stringify({ limit: 50, library_id: "lib1" }),
    });
  });

  it("saveAiSettings round-trips the settings body", async () => {
    const spy = mockFetch({ model_repo: "r" });
    await saveAiSettings({ model_repo: "r" } as never);
    expect(spy.mock.calls[0][0]).toBe("/api/v1/ai/settings");
    expect(spy.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("reads go through the shared client and forward the abort signal", async () => {
    const spy = mockFetch({ total: 0 });
    const signal = new AbortController().signal;
    await fetchAiCoverage(signal);
    expect(spy).toHaveBeenCalledWith("/api/v1/ai/coverage", { signal });
  });

  it("propagates the response body text on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model busy", { status: 409 })),
    );
    await expect(postModelLoad()).rejects.toThrow("model busy");
  });
});

describe("jobAgo", () => {
  const now = 1_000_000 * 1000;
  it.each([
    [now / 1000 - 10, "just now"],
    [now / 1000 - 5 * 60, "5 min ago"],
    [now / 1000 - 3 * 3600, "3 h ago"],
    [now / 1000 - 86400, "1 day ago"],
    [now / 1000 - 3 * 86400, "3 days ago"],
    [now / 1000 + 30, "just now"],
  ])("%s → %s", (createdAt, want) => {
    expect(jobAgo(createdAt, now)).toBe(want);
  });
});

describe("jobStatusLabel", () => {
  it("humanises known statuses and passes unknown ones through", () => {
    expect(jobStatusLabel("error")).toBe("Finished with errors");
    expect(jobStatusLabel("done")).toBe("Done");
    expect(jobStatusLabel("weird")).toBe("weird");
  });
});

describe("coveragePct", () => {
  it.each([
    [0, 0, 0],
    [0, 10, 0],
    [1, 1000, 1],
    [1, 3, 33],
    [9_996, 10_000, 99],
    [10, 10, 100],
  ])("%s of %s → %s", (part, whole, want) => {
    expect(coveragePct(part, whole)).toBe(want);
  });
});

describe("aiJobLabel", () => {
  it("follows the job from the queue through the model to tagging", () => {
    expect(aiJobLabel(null)).toBeNull();
    expect(aiJobLabel({ status: "queued" })).toBe("Queued…");
    expect(aiJobLabel({ status: "running", phase: "model" })).toBe("Waiting for model…");
    expect(aiJobLabel({ status: "running", phase: "tagging" })).toBe("Tagging…");
    expect(aiJobLabel({ status: "cancelling", phase: "model" })).toBe("Cancelling…");
  });
});

describe("throughput", () => {
  it("formats durations", () => {
    expect(formatDuration(42.4)).toBe("42 s");
    expect(formatDuration(170)).toBe("3 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(3900)).toBe("1 h 5 min");
  });

  it("formats rates per second, or per minute when slow", () => {
    expect(formatRate(3.24)).toBe("3.2 images/s");
    expect(formatRate(12.6)).toBe("13 images/s");
    expect(formatRate(0.5)).toBe("30 images/min");
    expect(formatRate(1 / 60)).toBe("1 image/min");
  });

  it("reads a running job with time left, an ended one with its span", () => {
    expect(jobThroughput({})).toBeNull();
    expect(jobThroughput({ rate: 2, eta_s: 120 })).toBe("2.0 images/s · 2 min left");
    expect(jobThroughput({ rate: 2, eta_s: 0 })).toBe("2.0 images/s · almost done");
    expect(jobThroughput({ rate: 2, elapsed_s: 45 })).toBe("2.0 images/s · 45 s");
  });
});

describe("libraryCoverageRows", () => {
  const names: Record<string, string> = { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta" };
  it("lists libraries with work left, most first, apart from finished ones", () => {
    const { todo, done } = libraryCoverageRows(
      [
        { library_id: "a", total: 10, ai_tagged: 10 },
        { library_id: "b", total: 100, ai_tagged: 90 },
        { library_id: "c", total: 50, ai_tagged: 0 },
        { library_id: "d", total: 5, ai_tagged: 5 },
      ],
      (id) => names[id],
    );
    expect(todo.map((r) => [r.name, r.untagged])).toEqual([
      ["Gamma", 50],
      ["Beta", 10],
    ]);
    expect(todo[1].pct).toBe(90);
    expect(done.map((r) => r.name)).toEqual(["Alpha", "Delta"]);
  });
});
