import { cn } from "../../lib/cn";

/**
 * The app's one progress bar: a thin raised track with a brand fill. A real
 * <progress>, so assistive tech reads value/max without extra ARIA.
 */
export function ProgressBar({
  value,
  max = 100,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  max?: number;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <progress
      className={cn(
        "w-full h-1.5 rounded [&::-webkit-progress-bar]:bg-raised [&::-webkit-progress-value]:bg-brand-500 [&::-moz-progress-bar]:bg-brand-500",
        className,
      )}
      value={value}
      max={max}
      aria-label={ariaLabel}
    />
  );
}
