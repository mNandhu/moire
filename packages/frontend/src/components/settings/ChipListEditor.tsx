import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { cn } from "../../lib/cn";
import { addPieces } from "../../lib/lists";

/**
 * An editable list of short entries as removable pills, with a comma
 * separated add box. How a typed piece becomes an entry (`toEntry`, null to
 * drop it) and what makes two entries the same (`keyOf`) stay with the
 * caller, as does the list itself (`entries` / `onChange`).
 */
export function ChipListEditor({
  entries,
  onChange,
  toEntry,
  keyOf,
  label,
  addLabel,
  placeholder,
  emptyText,
  display = (e) => e,
  entryClass,
}: {
  entries: string[];
  onChange: (next: string[]) => void;
  toEntry: (piece: string) => string | null;
  keyOf?: (entry: string) => string;
  /** The pill group's accessible name. */
  label: string;
  /** The add box's accessible name. */
  addLabel: string;
  placeholder: string;
  emptyText: string;
  /** How an entry reads on its pill. */
  display?: (entry: string) => string;
  entryClass?: (entry: string) => string | undefined;
}) {
  const [text, setText] = useState("");

  const add = () => {
    onChange(addPieces(entries, text, toEntry, keyOf));
    setText("");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" aria-label={label}>
        {entries.length === 0 && <span className="text-sm text-faint">{emptyText}</span>}
        {entries.map((entry) => (
          <span
            key={entry}
            className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-raised border border-line text-xs text-neutral-200"
          >
            <span className={cn(entryClass?.(entry))}>{display(entry)}</span>
            <button
              type="button"
              onClick={() => onChange(entries.filter((e) => e !== entry))}
              aria-label={`Remove ${display(entry)}`}
              title="Remove"
              className="inline-flex items-center justify-center h-5 w-5 rounded-full text-faint hover:text-white hover:bg-line"
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={addLabel}
          className="flex-1"
        />
        <Button type="submit" disabled={!text.trim()}>
          Add
        </Button>
      </form>
    </div>
  );
}
