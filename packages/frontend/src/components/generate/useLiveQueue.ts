import { useEffect, useState } from "react";
import { coverAspect } from "../../lib/batches";
import { useComfyStatus } from "../../lib/generate";
import { imagesLeft, legClock, queueLegs, type Leg } from "../../lib/queueClock";

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
 * is queued.
 */
export function useLiveQueue(): LiveQueue | null {
  const { data: status, dataUpdatedAt } = useComfyStatus();
  const now = useNow();
  const { legs, total } = queueLegs((status?.active ?? []).filter((a) => !a.test));
  if (!status || !legs.length) return null;
  const paused = !status.connected;
  const elapsed = paused ? 0 : Math.max(0, (now - dataUpdatedAt) / 1000);
  return {
    paused,
    left: Math.max(0, total - elapsed),
    images: imagesLeft(legs),
    legs: legs.map((l) => ({ ...l, ...legClock(l, elapsed), aspect: coverAspect(l.width, l.height) })),
  };
}
