import { clockText, etaLabel } from "./format";
import type { GenRequest } from "./generate";

/**
 * Run-time estimates as the Generate pages show them. The server estimates
 * each request from past runs (services/generation_estimate.py); this rounds
 * them for reading, works out what's left of a batch, and how far along a
 * running request is. Pure.
 *
 * An estimate is never shown more precise than it is: under a minute to 5s,
 * under ten minutes to 10s, else to the minute, and always "about".
 */




/** Past this share of its estimate a request is "taking longer than usual". */
const OVERRUN = 1.3;
/** A running request's fill stops here until it ends: it never looks done early. */
const FILL_CAP = 0.95;

/** Where a running request is against its estimate: on time, past it but
 * not by much (finishing), or well past it (late). */
export type RunPhase = "on-time" | "finishing" | "late";

/** How far along a running request is: `fill` 0 to {@link FILL_CAP},
 * seconds `left` (0 once past the estimate), seconds `over` it, and the
 * phase. Null without an estimate. */
export function runProgress(
  expected: number | null | undefined,
  elapsed: number | null | undefined,
): { fill: number; left: number; over: number; phase: RunPhase } | null {
  if (!expected || expected <= 0) return null;
  const e = Math.max(0, elapsed ?? 0);
  return {
    fill: Math.min(FILL_CAP, e / expected),
    left: Math.max(0, expected - e),
    over: Math.max(0, e - expected),
    phase: e <= expected ? "on-time" : e <= expected * OVERRUN ? "finishing" : "late",
  };
}


const UNFINISHED = new Set(["pending", "queued", "running"]);

/**
 * Seconds left on a batch's unfinished requests: a running one counts what's
 * left of its estimate (nothing once it's past it). Null when nothing is left
 * or some request has no estimate; `over` when a running one is overrunning.
 */
export function batchLeft(
  requests: readonly Pick<GenRequest, "state" | "expected" | "elapsed">[],
): { seconds: number; over: boolean } | null {
  const open = requests.filter((q) => UNFINISHED.has(q.state));
  if (!open.length) return null;
  let seconds = 0;
  let over = false;
  for (const q of open) {
    if (q.expected == null) return null;
    if (q.state === "running") {
      seconds += Math.max(0, q.expected - (q.elapsed ?? 0));
      over ||= runProgress(q.expected, q.elapsed)?.phase === "late";
    } else {
      seconds += q.expected;
    }
  }
  return { seconds, over };
}

/** What a time-left reads: "about 2m left"; near the end "Almost done",
 * which turns to "Taking longer than usual" once it overruns. */
export function leftLabel(left: { seconds: number; over: boolean }): string {
  if (left.seconds >= 3) return `${etaLabel(left.seconds)} left`;
  return left.over ? "Taking longer than usual" : "Almost done";
}

/** An estimate for a batch not queued yet, as the server gives it. */
export type NewEstimate = {
  seconds: number | null;
  load: number | null;
  ahead: number | null;
  basis: "exact" | "checkpoint" | "generator" | null;
  samples: number;
};

/** The Queue button's tooltip: "Should take about 1m 10s, after about 2m
 * already queued". Undefined without a number. */
export function queueTitle(e: NewEstimate | null | undefined): string | undefined {
  if (!e || e.seconds == null) return undefined;
  const after = e.ahead != null && e.ahead >= 1 ? `, after ${etaLabel(e.ahead)} already queued` : "";
  return `Should take ${etaLabel(e.seconds)}${after}`;
}

/** ComfyUI's own progress: "3 12 / 28" (node, then step of steps). */
export function stepsLabel(req: Pick<GenRequest, "progress">): string | null {
  if (!req.progress) return null;
  const steps = `${req.progress.value} / ${req.progress.max}`;
  return req.progress.node ? `${req.progress.node} ${steps}` : steps;
}

/** What a request's loader cell shows. */
export type CellProgress = {
  /** The big clock (time left, how far over, or time so far); null when queued. */
  big: string | null;
  caption: string;
  /** Hover text: ComfyUI's steps, the usual time. Empty when there is none. */
  tip: string;
  /** 0 to 1: ComfyUI's steps when it sends them, else the time against the estimate. */
  progress: number | null;
  fill: number;
  late: boolean;
  /** The bar is striped: past the estimate. */
  striped: boolean;
};

/**
 * The loader cell of a request: waiting in Moiré's queue or ComfyUI's reads
 * the same (queued); running shows the time left against the estimate, else
 * the time so far. `elapsed` is the live seconds of a running request. Pure.
 */
export function cellProgress(req: Pick<GenRequest, "state" | "progress" | "expected">, elapsed: number | null): CellProgress {
  const running = req.state === "running";
  const run = running ? runProgress(req.expected, elapsed) : null;
  const steps = req.progress && req.progress.max ? req.progress.value / req.progress.max : null;
  const late = run?.phase === "late";
  const progress = steps ?? run?.fill ?? null;
  const big = !running
    ? null
    : run
      ? run.phase === "on-time"
        ? clockText(run.left, "ceil")
        : `+${clockText(run.over)}`
      : elapsed != null
        ? clockText(elapsed)
        : null;
  const caption = !running
    ? "Queued"
    : run
      ? run.phase === "on-time"
        ? "left"
        : late
          ? "Taking longer than usual"
          : "Finishing up"
      : (stepsLabel(req) ?? "Running");
  const tip = [stepsLabel(req), run && req.expected ? `Usually about ${clockText(req.expected)}` : null].filter(Boolean).join(" · ");
  return { big, caption, tip, progress, fill: progress ?? 0, late, striped: !!run && run.phase !== "on-time" };
}
