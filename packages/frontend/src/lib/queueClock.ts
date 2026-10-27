import type { ActiveBatch, QueueFrame } from "./generate";

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
  width: number | null;
  height: number | null;
  /** One per image asked. */
  frames: QueueFrame[];
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
  // The one being made first, so a guessed start never counts what's behind it.
  const order = [...active].sort((x, y) => Number(!!y.running) - Number(!!x.running));
  for (const a of order) {
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
      guess: a.eta == null,
      start,
      end,
      width: a.width ?? null,
      height: a.height ?? null,
      frames: a.frames,
    });
  }
  // The one being made leads, then by when each starts.
  legs.sort((x, y) => Number(y.running) - Number(x.running) || x.start - y.start);
  return { legs, total: cursor };
}

/**
 * Which live batch is in front of the queue and which wait behind it, in the
 * same run order queueLegs uses (the one being made, then by start). Test
 * batches are left out. Pure.
 */
export function queueRoles(active: readonly ActiveBatch[]): { front: number | undefined; behind: Set<number> } {
  const legs = queueLegs(active.filter((a) => !a.test)).legs;
  return { front: legs[0]?.id, behind: new Set(legs.slice(1).map((l) => l.id)) };
}

/** Images still to make: frames waiting or being made. Pure. */
export function imagesLeft(legs: readonly Leg[]): number {
  return legs.reduce((n, l) => n + l.frames.filter((f) => f.state === "waiting" || f.state === "making").length, 0);
}

/** Where a leg is `elapsed` seconds after the times were read: how long
 * until it starts (0 once going) and until it is done. Pure. */
export function legClock(leg: Leg, elapsed: number): { startsIn: number; left: number } {
  return { startsIn: Math.max(0, leg.start - elapsed), left: Math.max(0, leg.end - elapsed) };
}

