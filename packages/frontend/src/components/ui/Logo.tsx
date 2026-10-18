import { cn } from "../../lib/cn";

/**
 * The Moiré mark: two offset sets of concentric rings. Where they cross, the
 * strokes beat against each other, the interference pattern the app is
 * named for. Kept in sync with `public/favicon.svg`.
 */
export function MoireMark({
  size = 26,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      strokeWidth={1.7}
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <g stroke="currentColor" className="text-neutral-100">
        <circle cx="13" cy="16" r="2.5" />
        <circle cx="13" cy="16" r="6.5" />
        <circle cx="13" cy="16" r="10.5" />
      </g>
      <g stroke="currentColor" className="text-brand-400">
        <circle cx="19" cy="16" r="2.5" />
        <circle cx="19" cy="16" r="6.5" />
        <circle cx="19" cy="16" r="10.5" />
      </g>
    </svg>
  );
}
