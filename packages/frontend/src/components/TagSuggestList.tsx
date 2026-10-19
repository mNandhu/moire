import { useMemo } from "react";
import { fuzzyRank } from "../lib/fuzzy";
import { splitBoilerplate } from "../lib/boilerplate";
import { useBoilerplate } from "../lib/queries";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/cn";
import { formatSearchTag, isManual, isPrompt, tagQueryText } from "../lib/tags";

export type TagSuggestion = { _id: string; count: number };

const MAX_SUGGESTIONS = 8;

/**
 * Known tags matching typed text, best first: fuzzy-ranked on the display
 * form (so `blue_eyes` and `blue eyes` find the same tag), boilerplate after
 * every other match ("best" offers "best friend" before "best quality").
 */
export function useTagMatches(text: string, pool: readonly TagSuggestion[]): TagSuggestion[] {
  const isBoilerplate = useBoilerplate();
  return useMemo(() => {
    const q = text.trim();
    if (!q) return [];
    const ranked = fuzzyRank(tagQueryText(q), [...pool], (s) => formatSearchTag(s._id), pool.length);
    const { kept, boilerplate } = splitBoilerplate(ranked, (s) => s._id, isBoilerplate);
    return [...kept, ...boilerplate].slice(0, MAX_SUGGESTIONS);
  }, [text, pool, isBoilerplate]);
}

/**
 * The tag autocomplete dropdown: each row a tag with its kind and image
 * count. Positioned under its input by the caller's `relative` wrapper.
 */
export function TagSuggestList({
  matches,
  active,
  onActive,
  onPick,
}: {
  matches: readonly TagSuggestion[];
  active: number;
  onActive: (i: number) => void;
  onPick: (s: TagSuggestion) => void;
}) {
  return (
    <ul
      className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40 py-1"
      role="listbox"
    >
      {matches.map((s, i) => (
        <li key={s._id} role="option" aria-selected={i === active}>
          <button
            type="button"
            onMouseEnter={() => onActive(i)}
            onMouseDown={(e) => {
              // mousedown (not click) so it fires before input blur.
              e.preventDefault();
              onPick(s);
            }}
            className={cn(
              "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
              i === active ? "bg-brand-900/30" : "hover:bg-neutral-800/60",
            )}
          >
            <span className="flex items-center gap-2 min-w-0">
              <span className="truncate text-neutral-100">{formatSearchTag(s._id)}</span>
              {isManual(s._id) && (
                <Badge tone="success" className="text-2xs shrink-0">
                  manual
                </Badge>
              )}
              {isPrompt(s._id) && (
                <Badge tone="info" className="text-2xs shrink-0">
                  prompt
                </Badge>
              )}
            </span>
            <span className="tabular-nums text-xs text-faint shrink-0">
              {s.count.toLocaleString()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
