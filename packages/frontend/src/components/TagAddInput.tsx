import { useMemo, useState } from "react";
import { useTagAggregate } from "../lib/queries";
import { bareTagPool, canonicalName } from "../lib/tags";
import type { TagSuggestion } from "../lib/tagSuggest";
import { cn } from "../lib/cn";
import { useSuggestNav, useTagMatches } from "../hooks/useSuggestNav";
import { TagSuggestList } from "./TagSuggestList";

/**
 * A small dashed field to add one tag at a time: library tags as
 * suggestions, free text allowed. Enter or comma adds what was typed (or the
 * highlighted match once arrowed to), Tab takes the highlighted match,
 * Escape closes the list or clears the text. `rank` reorders the matches
 * (attire first) and `noteOf` labels a row.
 */
export function TagAddInput({
  onAdd,
  taken,
  ariaLabel,
  rank,
  noteOf,
  bare,
  commitOnBlur,
  className,
}: {
  onAdd: (tag: string) => void;
  taken: ReadonlySet<string>;
  ariaLabel: string;
  rank?: (matches: TagSuggestion[]) => TagSuggestion[];
  noteOf?: (id: string) => string | null;
  /** Borderless, filling its row: for a token box that draws the border. */
  bare?: boolean;
  /** Leaving the field adds what was typed (a form saved without Enter
   * keeps it). */
  commitOnBlur?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const { data: tagAgg } = useTagAggregate({ includePrompt: true });
  const pool = useMemo(() => bareTagPool(tagAgg ?? []).filter((t) => !taken.has(t._id)), [tagAgg, taken]);
  const ranked = useTagMatches(text, pool);
  const matches = useMemo(() => (rank ? rank(ranked) : ranked), [ranked, rank]);
  const add = (tag: string) => {
    const t = canonicalName(tag);
    if (t) onAdd(t);
    setText("");
  };
  const open = !!text.trim() && matches.length > 0;
  const nav = useSuggestNav({
    matches,
    open,
    onPick: (m) => add(m._id),
    onClose: () => setText(""),
    enter: "moved",
    tab: true,
    resetKey: text,
  });
  return (
    <div className={cn("relative", className)}>
      <input
        aria-label={ariaLabel}
        value={text}
        placeholder="Add tag"
        onChange={(e) => setText(e.target.value)}
        onBlur={commitOnBlur ? () => text.trim() && add(text) : undefined}
        onKeyDown={(e) => {
          if (nav.onKeyDown(e)) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Escape") setText("");
        }}
        {...nav.ariaProps}
        className={cn(
          "h-7 bg-transparent px-2 text-sm text-neutral-100 placeholder:text-faint outline-none",
          bare ? "w-full" : "w-32 rounded-md border border-dashed border-line-strong focus:w-48 focus:border-solid focus:border-brand-600/60",
        )}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 w-64">
          <TagSuggestList
            matches={matches}
            active={nav.active}
            onActive={nav.setActive}
            onPick={(m) => add(m._id)}
            noteOf={noteOf}
          />
        </div>
      )}
    </div>
  );
}
