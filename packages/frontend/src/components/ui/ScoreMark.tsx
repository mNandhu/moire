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
const MARKER_DIGIT =
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

/**
 * The score editor: the same grease-pencil digits the gallery tiles show, so
 * marking a score looks like the mark it leaves. The chosen digit is drawn in
 * amber; clicking it again clears the score. `quiet` hides the other digits
 * until the enclosing `group` is pointed at or focused (a result tile, where
 * at rest only the mark shows, as on the gallery's tiles).
 */
export function ScorePicker({
  value,
  onSet,
  size = "md",
  quiet = false,
}: {
  value: number;
  onSet: (n: number) => void;
  size?: "md" | "sm";
  quiet?: boolean;
}) {
  const box = size === "sm" ? "w-5 h-6" : "w-7 h-8";
  return (
    <div className="inline-flex items-center gap-0.5" role="radiogroup" aria-label="Score">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = n === value;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Set score ${n}`}
            title={on ? "Clear score" : `Score ${n}`}
            onClick={() => onSet(on ? 0 : n)}
            className={cn(
              box,
              on
                ? cn(MARKER_DIGIT, size === "sm" ? "text-[20px]" : "text-[24px]")
                : cn(
                    "font-marker leading-none hover:text-amber-200/80 transition-colors",
                    // Over a picture, a dim digit needs more light to read.
                    size === "sm" ? "text-white/60" : "text-white/30",
                    size === "sm" ? "text-[18px]" : "text-[22px]",
                    quiet && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
                  ),
            )}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}
