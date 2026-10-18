import { cn } from "../../lib/cn";

/**
 * An image's 1-5 score as a hand-written amber digit, the way prints get
 * marked up on a contact sheet (Caveat Brush, chosen for an unambiguous 4 at
 * tile size; Permanent Marker's open 4 read as "ч"). A score is a judgement put on a picture, not
 * progress, so it deliberately isn't a meter (bars, dots and rings all read
 * as loading). One colour on purpose: colour already means rating elsewhere.
 */
// Legibility on any picture: the tile's bottom scrim puts it on dark most of
// the time, and this halo (a tight dark outline plus a soft drop) covers the
// rest, e.g. a yellow region under the digit. Checked against flat amber,
// white and yellow with no scrim at all.
export const MARKER_DIGIT =
  "font-marker text-amber-300 leading-none inline-block -rotate-6 " +
  "[text-shadow:0_0_1px_rgb(0_0_0/0.95),0_0_2px_rgb(0_0_0/0.9),0_1px_4px_rgb(0_0_0/0.75)]";

export function ScoreMark({ score, className }: { score: number; className?: string }) {
  const n = Math.max(1, Math.min(5, Math.round(score)));
  return (
    <span
      className={cn(MARKER_DIGIT, "text-[22px]", className)}
      title={`Score ${n}/5`}
      aria-label={`Score ${n} of 5`}
    >
      {n}
    </span>
  );
}
