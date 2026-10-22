import { useEffect, useState } from "react";
import { coverAspect } from "../../lib/batches";
import { useBatches, useComfyStatus } from "../../lib/generate";
import { legClock, queueLegs, type Leg } from "../../lib/queueClock";

/** Ticks once a second. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export type LiveLeg = Leg & {
  /** Seconds until it starts, 0 once going. */
  startsIn: number;
  /** Seconds until it is done. */
  left: number;
  /** Its images' shape, for frames drawn at it. */
  aspect: number;
  /** Thumbnails of its images already in the library, in order. */
  thumbs: string[];
};

export type LiveQueue = {
  legs: LiveLeg[];
  /** ComfyUI can't be reached: the batches wait, their times stand still. */
  paused: boolean;
  /** Seconds until the whole queue is done. */
  left: number;
  /** Images still to make. */
  images: number;
};

/**
 * The ComfyUI queue (test runs left out) with every time run on to now: the
 * status poll's times tick down each second between polls. Null when nothing
 * is queued. `limit` is how many recent batches to read shapes and
 * thumbnails from (match the page's own batch list to share its query).
 */
export function useLiveQueue(limit = 50): LiveQueue | null {
  const { data: status, dataUpdatedAt } = useComfyStatus();
  const { data: batches } = useBatches(limit);
  const now = useNow();
  const { legs, total } = queueLegs((status?.active ?? []).filter((a) => !a.test));
  if (!status || !legs.length) return null;
  const paused = !status.connected;
  const elapsed = paused ? 0 : Math.max(0, (now - dataUpdatedAt) / 1000);
  const byId = new Map((batches ?? []).map((b) => [b._id, b]));
  return {
    paused,
    left: Math.max(0, total - elapsed),
    images: legs.reduce((n, l) => n + Math.max(0, l.requests - l.finished), 0),
    legs: legs.map((l) => {
      const b = byId.get(l.id);
      return { ...l, ...legClock(l, elapsed), aspect: coverAspect(b?.width ?? null, b?.height ?? null), thumbs: b?.thumbs ?? [] };
    }),
  };
}
