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

/** Seconds rounded as shown. */
export function roundEta(seconds: number): number {
  const s = Math.max(0, seconds);
  if (s < 60) return Math.max(5, Math.round(s / 5) * 5);
  if (s < 600) return Math.round(s / 10) * 10;
  return Math.round(s / 60) * 60;
}

/** "45s", "2m 30s", "14m", "1h 20m": a rounded duration without "about". */
export function etaShort(seconds: number): string {
  const s = roundEta(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

/** "about 2m 30s". */
export const etaLabel = (seconds: number) => `about ${etaShort(seconds)}`;

/** Past this share of its estimate a request is "taking longer than usual". */
export const OVERRUN = 1.3;
/** A running request's fill stops here until it ends: it never looks done early. */
export const FILL_CAP = 0.95;

/** How far along a running request is: `fill` 0 to {@link FILL_CAP}, and
 * whether it has run well past its estimate. Null without an estimate. */
export function developing(
  expected: number | null | undefined,
  elapsed: number | null | undefined,
): { fill: number; over: boolean } | null {
  if (!expected || expected <= 0) return null;
  const e = Math.max(0, elapsed ?? 0);
  return { fill: Math.min(FILL_CAP, e / expected), over: e > expected * OVERRUN };
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
      over ||= !!developing(q.expected, q.elapsed)?.over;
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

const BASIS: Record<NonNullable<NewEstimate["basis"]>, (n: number) => string> = {
  exact: (n) => `From the last ${n === 1 ? "run" : `${n} runs`} with these settings`,
  checkpoint: () => "Scaled from this checkpoint's runs at other sizes or steps",
  generator: () => "Scaled from runs on other checkpoints",
};

/**
 * What the next-batch card says: the time, notes on a checkpoint load and
 * work already queued, and where the number comes from. Null when there's
 * no number (no runs to go on yet).
 */
export function estimateNotes(
  e: NewEstimate | null | undefined,
  checkpoint: string | null,
): { time: string; notes: string[]; basis: string | null } | null {
  if (!e || e.seconds == null) return null;
  const notes: string[] = [];
  if (e.load != null && e.load >= 1) {
    notes.push(`Includes ${etaLabel(e.load)} to load ${checkpoint ?? "the checkpoint"}.`);
  }
  if (e.ahead != null && e.ahead >= 1) notes.push(`Starts after ${etaLabel(e.ahead)} of work already queued.`);
  return { time: etaLabel(e.seconds), notes, basis: e.basis ? BASIS[e.basis](e.samples) : null };
}

/** The Queue button's tooltip: "Should take about 1m 10s, after about 2m
 * already queued". Undefined without a number. */
export function queueTitle(e: NewEstimate | null | undefined): string | undefined {
  if (!e || e.seconds == null) return undefined;
  const after = e.ahead != null && e.ahead >= 1 ? `, after ${etaLabel(e.ahead)} already queued` : "";
  return `Should take ${etaLabel(e.seconds)}${after}`;
}
