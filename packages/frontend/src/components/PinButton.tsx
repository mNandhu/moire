import { Loader2, Pin } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * The pin on an image tile that makes it a tag's cover (a character's
 * avatar). Shown on hover of the tile's `group/img`, always when pinned or
 * while the change is in flight.
 */
export function PinButton({
  on,
  pending,
  disabled,
  noun,
  onClick,
}: {
  on: boolean;
  pending: boolean;
  disabled: boolean;
  noun: "avatar" | "cover";
  onClick: () => void;
}) {
  const Noun = noun === "avatar" ? "Avatar" : "Cover";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      aria-busy={pending}
      aria-label={on ? `Unpin ${noun}` : `Use as ${noun}`}
      title={pending ? "Updating…" : on ? `${Noun}. Click to let Moiré pick again` : `Use as ${noun}`}
      className={cn(
        "absolute right-1 top-1 h-6 w-6 rounded-full inline-flex items-center justify-center transition-opacity",
        on || pending
          ? "bg-brand-500 text-white"
          : "bg-black/60 text-white/85 hover:text-white opacity-0 group-hover/img:opacity-100 focus-visible:opacity-100",
        disabled && !pending && !on && "group-hover/img:opacity-40",
      )}
    >
      <Pin size={12} />
    </button>
  );
}

/** Dims a tile behind a spinner while its pin is in flight. */
export function PendingVeil() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
      <Loader2 size={20} className="animate-spin text-white" />
    </div>
  );
}
