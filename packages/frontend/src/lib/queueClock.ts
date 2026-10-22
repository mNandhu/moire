import type { ActiveBatch } from "./generate";

export type Leg = {
  id: number;
  name: string;
  requests: number;
  finished: number;
  /** ComfyUI is making one of its images now. */
  running: boolean;
  /** How far the image being made is, 0..1. */
  step: number;
  /** Seconds of its own work left; a guess from the others when it has no estimate. */
  seconds: number;
  guess: boolean;
  /** Seconds from now until its first image starts and its last is done.
   * Batches take turns, so the span holds the others' turns too. */
  start: number;
  end: number;
};

/**
 * The queue's batches with when each starts and is done, in run order. The
 * server's times are used where it has them; past a request with no estimate,
 * a batch is guessed at the average seconds a request of those that have
 * one (or 1 s if none has), run after everything before it. Pure.
 */
export function queueLegs(active: readonly ActiveBatch[]): { legs: Leg[]; total: number } {
  const known = active.filter((a) => a.eta != null);
  const left = known.reduce((n, a) => n + Math.max(0, a.requests - a.finished), 0);
  const perRequest = left ? known.reduce((n, a) => n + (a.eta ?? 0), 0) / left : 1;
  const legs: Leg[] = [];
  let cursor = 0;
  for (const a of active) {
    const seconds = a.eta ?? Math.max(0, a.requests - a.finished) * perRequest;
    const timed = a.starts_in != null && a.done_in != null;
    const start = timed ? a.starts_in! : cursor;
    const end = timed ? a.done_in! : start + seconds;
    cursor = Math.max(cursor, end);
    legs.push({
      id: a._id,
      name: a.name,
      requests: a.requests,
      finished: a.finished,
      running: !!a.running,
      step: a.progress?.max ? a.progress.value / a.progress.max : 0,
      seconds,
      guess: !timed || a.eta == null,
      start,
      end,
    });
  }
  // The one being made leads, then by when each starts.
  legs.sort((x, y) => Number(y.running) - Number(x.running) || x.start - y.start);
  return { legs, total: cursor };
}

/** Where a leg is `elapsed` seconds after the times were read: how long
 * until it starts (0 once going) and until it is done. Pure. */
export function legClock(leg: Leg, elapsed: number): { startsIn: number; left: number } {
  return { startsIn: Math.max(0, leg.start - elapsed), left: Math.max(0, leg.end - elapsed) };
}

/** "0:42", "9:05", "1:02:09": a countdown as a timer shows it. Pure. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  if (h) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}
