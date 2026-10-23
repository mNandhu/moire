import { etaLabel } from "./format";
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
