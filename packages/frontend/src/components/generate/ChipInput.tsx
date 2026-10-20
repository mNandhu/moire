import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { displayWord, isEmbedding } from "../../lib/compose";
import { tagName } from "../../lib/tags";
import { chipBorderStyle } from "../../lib/tagColour";
import { useTagMarks } from "../../hooks/useTagMarks";
import { TagSuggestList, useTagMatches, type TagSuggestion } from "../TagSuggestList";

/** Typed text as a chip: canonical underscores for tags; embeddings as typed. */
function toChip(text: string): string {
  const t = text.trim();
  if (isEmbedding(t)) return t;
  return t.replace(/\s+/g, "_");
}

/**
 * Library tags as composer suggestions: one row per bare name (an AI tag and
 * its prompt twin are one word in a prompt), counts summed.
 */
export function bareTagPool(tags: readonly TagSuggestion[]): TagSuggestion[] {
  const counts = new Map<string, number>();
  for (const t of tags) {
    const name = tagName(t._id);
    counts.set(name, (counts.get(name) ?? 0) + t.count);
  }
  return [...counts].map(([_id, count]) => ({ _id, count }));
}

/**
 * A prompt block's chips: tags with autocomplete from the library, and
 * installed embeddings (`embedding:name`, styled apart). Enter or comma adds;
 * Backspace on an empty input removes the last chip.
 */
export function ChipInput({
  value,
  onChange,
  suggestions,
  embeddings,
  label,
  invalid,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions: readonly TagSuggestion[];
  embeddings: readonly string[];
  label: string;
  invalid?: boolean;
}) {
  const { outlines } = useTagMarks();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => new Set(value), [value]);
  const pool = useMemo(() => suggestions.filter((s) => !selected.has(s._id)), [suggestions, selected]);
  const resources = useMemo(
    () => embeddings.map((n) => ({ _id: `embedding:${n}`, count: 0 })).filter((s) => !selected.has(s._id)),
    [embeddings, selected],
  );
  const matches = useTagMatches(text, pool, resources);
  useEffect(() => setActive(0), [text]);
  const showList = open && matches.length > 0;

  const add = (raw: string) => {
    const chip = toChip(raw);
    setText("");
    setActive(0);
    if (chip && !selected.has(chip)) onChange([...value, chip]);
  };
  const remove = (chip: string) => onChange(value.filter((c) => c !== chip));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && showList) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp" && showList) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (showList && matches[active]) add(matches[active]._id);
      else if (text.trim()) add(text);
    } else if (e.key === ",") {
      e.preventDefault();
      if (text.trim()) add(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      remove(value[value.length - 1]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 rounded-lg border bg-neutral-950/70 px-2 py-1.5 text-sm transition-colors cursor-text focus-within:border-brand-600/60",
          invalid ? "border-red-700" : "border-neutral-800",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((chip) => {
          const emb = isEmbedding(chip);
          return (
            <span
              key={chip}
              title={emb ? "Embedding" : undefined}
              style={emb || !outlines ? undefined : chipBorderStyle(chip)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border pl-2 pr-1 py-0.5",
                emb ? "border-teal-700/70 bg-teal-900/30 text-teal-100" : "border-line bg-raised text-neutral-100",
              )}
            >
              <span className="truncate max-w-[14rem]">{displayWord(chip)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(chip);
                }}
                className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
                aria-label={`Remove ${displayWord(chip)}`}
              >
                <X size={13} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : "Add tag"}
          aria-label={label}
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          className="flex-1 min-w-[5rem] bg-transparent px-1 py-0.5 text-neutral-100 placeholder:text-faint outline-none focus-visible:shadow-none"
        />
      </div>
      {showList && (
        <TagSuggestList matches={matches} active={active} onActive={setActive} onPick={(s) => add(s._id)} />
      )}
    </div>
  );
}
