/** Room kept between a dropdown and the edge of the screen, px. */
const EDGE = 8;

/**
 * Which side of its field a dropdown opens on, and how tall it may be:
 * below when it fits there, else on the side with more room (on a phone,
 * usually up: the field sits just above the keyboard). `above` and `below`
 * are the free px on each side of the field; `want` the list's full height.
 */
export function dropSide(above: number, below: number, want: number): { up: boolean; max: number } {
  if (below - EDGE >= want) return { up: false, max: want };
  const up = above > below;
  return { up, max: Math.max(0, Math.min(want, (up ? above : below) - EDGE)) };
}
