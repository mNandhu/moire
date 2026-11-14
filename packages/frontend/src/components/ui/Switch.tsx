import { cn } from "@/lib/cn";

const SIZES = {
  sm: { track: "h-4 w-7", knob: "left-0.5 top-0.5 h-3 w-3", on: "translate-x-3" },
  md: { track: "h-5 w-[34px]", knob: "left-[3px] top-[3px] h-3.5 w-3.5", on: "translate-x-3.5" },
} as const;

/** The switch's drawing: a track and its knob, slid across when on. */
export function SwitchTrack({
  on,
  size = "md",
  disabled,
  className,
}: {
  on: boolean;
  size?: keyof typeof SIZES;
  disabled?: boolean;
  className?: string;
}) {
  const s = SIZES[size];
  return (
    <span
      className={cn(
        "relative shrink-0 rounded-full transition-colors",
        s.track,
        on ? "bg-brand-600" : "bg-line-strong",
        disabled && "opacity-50",
        className,
      )}
    >
      <span className={cn("absolute rounded-full bg-neutral-100 shadow transition-transform", s.knob, on && s.on)} />
    </span>
  );
}

/** An on/off switch on its own, named by `aria-label`. */
export function Switch({
  on,
  onChange,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  size?: keyof typeof SIZES;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={() => onChange(!on)}
      className="group/switch shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <SwitchTrack on={on} size={size} className="block group-hover/switch:brightness-110" />
    </button>
  );
}
