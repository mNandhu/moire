/** How far ahead a flick carries the sheet, in ms of its release speed. */
const PROJECT_MS = 200;

/**
 * Where a dragged bottom sheet settles: the stop nearest to where it would
 * coast to, so a flick goes on to the next stop and a slow drag lands on the
 * closest. `offset` and `stops` are distances down from fully open (px),
 * `velocity` is px/ms (down is positive). Returns the stop's index.
 */
export function snapSheet(offset: number, velocity: number, stops: readonly number[]): number {
  const aim = offset + velocity * PROJECT_MS;
  let best = 0;
  for (let i = 1; i < stops.length; i++) {
    if (Math.abs(stops[i] - aim) < Math.abs(stops[best] - aim)) best = i;
  }
  return best;
}
