import type { CSSProperties, ReactNode } from "react";
import { Undo2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { displayWord } from "@/features/generate/lib/compose";
import { Tooltip } from "@/components/ui/Tooltip";

/**
 * A tag chip with an x to take it out, or an arrow to bring a struck one
 * back; the attire group shows before the tag when known. The outfit and
 * identity chips of the composer, the outfit dialog and the recipe editor.
 */
export function TagPill({
  tag,
  group,
  struck,
  onToggle,
  actionLabel,
  tip,
  style,
  className,
}: {
  tag: string;
  group?: string | null;
  struck?: boolean;
  onToggle: () => void;
  /** The button's accessible name; "Remove" or "Restore" and the tag by default. */
  actionLabel?: string;
  /** Hover text on the chip: a caveat about the tag. */
  tip?: ReactNode;
  /** Only while not struck (a border colour, say). */
  style?: CSSProperties;
  className?: string;
}) {
  const word = displayWord(tag);
  const pill = (
    <span
      style={struck ? undefined : style}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border py-0.5 pl-2 pr-1 text-sm",
        struck ? "border-line/60 text-faint line-through" : "border-line bg-raised text-neutral-100",
        className,
      )}
    >
      {group && <span className="text-[11px] text-muted no-underline">{group.replace(/_/g, " ")}</span>}
      {word}
      <button
        type="button"
        onClick={onToggle}
        aria-label={actionLabel ?? `${struck ? "Restore" : "Remove"} ${word}`}
        className="rounded p-0.5 text-muted no-underline hover:bg-line hover:text-neutral-100"
      >
        {struck ? <Undo2 size={13} /> : <X size={13} />}
      </button>
    </span>
  );
  return tip ? (
    <Tooltip content={tip} bubble>
      {pill}
    </Tooltip>
  ) : (
    pill
  );
}
