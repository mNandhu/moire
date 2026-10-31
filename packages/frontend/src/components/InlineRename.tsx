import { useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { cn } from "../lib/cn";
import { Input } from "./ui";

/**
 * A name shown as text with a pencil; the pencil swaps in a field that takes
 * the new name on Enter or on leaving it, and drops it on Escape. `onCommit`
 * gets the trimmed text once per edit (empty included: the caller decides
 * what that means). `reset` adds a button beside the field, as for an auto
 * name.
 */
export function InlineRename({
  value,
  onCommit,
  label,
  reset,
  className,
  inputClassName,
  textClassName,
  iconSize = 14,
}: {
  value: string;
  onCommit: (name: string) => void;
  /** What is named: the field is "<label> name", the pencil "Rename <label>". */
  label: string;
  reset?: { label: string; onReset: () => void } | null;
  className?: string;
  inputClassName?: string;
  /** The name's own text, `truncate` in a narrow row. */
  textClassName?: string;
  iconSize?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter or Escape closes the field, and its blur on unmount must not
  // commit a second time (or after an Escape).
  const closed = useRef(false);
  const close = () => {
    closed.current = true;
    setEditing(false);
  };
  const commit = () => {
    if (closed.current) return;
    close();
    onCommit(draft.trim());
  };
  if (editing) {
    return (
      <span
        key="edit"
        className={cn("flex items-center gap-2", className)}
        // Leaving the field and its reset button, not moving between them.
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) commit();
        }}
      >
        <Input
          autoFocus
          aria-label={`${label.charAt(0).toUpperCase()}${label.slice(1)} name`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") close();
          }}
          className={inputClassName}
        />
        {reset && (
          <button
            type="button"
            // Keeps the field's blur from committing first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              close();
              reset.onReset();
            }}
            className="shrink-0 text-xs text-muted hover:text-neutral-100"
          >
            {reset.label}
          </button>
        )}
      </span>
    );
  }
  return (
    <span key="view" className={cn("flex items-center gap-2", className)}>
      <span className={textClassName}>{value}</span>
      <button
        type="button"
        aria-label={`Rename ${label}`}
        title="Rename"
        onClick={() => {
          closed.current = false;
          setDraft(value);
          setEditing(true);
        }}
        className="shrink-0 rounded p-1 text-muted hover:bg-raised hover:text-neutral-100"
      >
        <Pencil size={iconSize} />
      </button>
    </span>
  );
}
