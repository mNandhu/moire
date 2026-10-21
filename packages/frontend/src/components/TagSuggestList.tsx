import { useMemo } from "react";
import { fuzzyRank } from "../lib/fuzzy";
import { splitBoilerplate } from "../lib/boilerplate";
import { useBoilerplate } from "../lib/queries";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/cn";
import { formatSearchTag, isManual, isPrompt, tagQueryText } from "../lib/tags";
import { resourceOf } from "../lib/imageFilter";

export type TagSuggestion = { _id: string; count: number };

const MAX_SUGGESTIONS = 8;
// Rows kept for loras and embeddings when tags also match: they rank below
// tags, but a long tag list mustn't hide them.
const RESOURCE_ROWS = 2;
const TYPED_KIND = /^(lora|embedding|emb|outfit):\s*(.*)$/i;

/**
 * The suggestions for typed text: tags fuzzy-ranked on their display form
 * (so `blue_eyes` and `blue eyes` find the same tag), boilerplate after
 * every other match ("best" offers "best friend" before "best quality"),
 * then loras and embeddings (`resources`, ids `lora:name` /
 * `embedding:name`) matched on their name, below the tags but always given
 * a row or two. Typing `lora:` (or `embedding:`, `emb:`) lists only that
 * kind. Pure.
 */
export function rankSuggestions(
  text: string,
  pool: readonly TagSuggestion[],
  resources: readonly TagSuggestion[],
  isBoilerplate: (tag: string) => boolean,
): TagSuggestion[] {
  const q = text.trim();
  if (!q) return [];
  const nameOf = (s: TagSuggestion) => s._id.slice(s._id.indexOf(":") + 1);
  const typed = TYPED_KIND.exec(q);
  if (typed) {
    const k = typed[1].toLowerCase();
    const kind = k === "lora" ? "lora:" : k === "outfit" ? "outfit:" : "embedding:";
    const ofKind = resources.filter((r) => r._id.startsWith(kind));
    const rest = typed[2].trim();
    return rest
      ? fuzzyRank(rest, ofKind, nameOf, MAX_SUGGESTIONS)
      : [...ofKind].sort((a, b) => b.count - a.count).slice(0, MAX_SUGGESTIONS);
  }
  const ranked = fuzzyRank(tagQueryText(q), [...pool], (s) => formatSearchTag(s._id), pool.length);
  const { kept, boilerplate } = splitBoilerplate(ranked, (s) => s._id, isBoilerplate);
  const tags = [...kept, ...boilerplate];
  const res = fuzzyRank(q, resources, nameOf, MAX_SUGGESTIONS);
  const head = tags.slice(0, MAX_SUGGESTIONS - Math.min(RESOURCE_ROWS, res.length));
  return [...head, ...res.slice(0, MAX_SUGGESTIONS - head.length)];
}

/** {@link rankSuggestions} with the user's boilerplate list. Loras and
 * embeddings only where the caller offers them (the gallery search). */
export function useTagMatches(
  text: string,
  pool: readonly TagSuggestion[],
  resources: readonly TagSuggestion[] = NONE,
): TagSuggestion[] {
  const isBoilerplate = useBoilerplate();
  return useMemo(
    () => rankSuggestions(text, pool, resources, isBoilerplate),
    [text, pool, resources, isBoilerplate],
  );
}

const NONE: TagSuggestion[] = [];

/** A lora or embedding search term's kind and name, or null for a tag. */
export function resourceLabel(id: string): { kind: string; name: string } | null {
  const r = resourceOf(id);
  return r ? { kind: r.kind === "lora" ? "LoRA" : r.kind === "outfit" ? "Outfit" : "Embedding", name: r.name } : null;
}

/**
 * The tag autocomplete dropdown: each row a tag with its kind and image
 * count, and its cover when `thumbOf` gives one. Positioned under its input
 * by the caller's `relative` wrapper, or wherever `className`/`style` put it.
 */
export function TagSuggestList({
  matches,
  active,
  onActive,
  onPick,
  thumbOf,
  noteOf,
  className,
  style,
}: {
  matches: readonly TagSuggestion[];
  active: number;
  onActive: (i: number) => void;
  onPick: (s: TagSuggestion) => void;
  thumbOf?: (id: string) => string | null;
  /** A short label for a row (e.g. a character known only to the tagger). */
  noteOf?: (id: string) => string | null;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <ul
      className={cn(
        "absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40 py-1",
        className,
      )}
      style={style}
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
              {thumbOf && <Thumb url={thumbOf(s._id)} />}
              <span className="truncate text-neutral-100">
                {resourceLabel(s._id)?.name ?? formatSearchTag(s._id)}
              </span>
              {resourceLabel(s._id) && (
                <Badge tone="warning" className="text-2xs shrink-0">
                  {resourceLabel(s._id)!.kind}
                </Badge>
              )}
              {isManual(s._id) && (
                <Badge tone="success" className="text-2xs shrink-0">
                  manual
                </Badge>
              )}
              {noteOf?.(s._id) && (
                <Badge tone="neutral" className="text-2xs shrink-0">
                  {noteOf(s._id)}
                </Badge>
              )}
              {isPrompt(s._id) && (
                <Badge tone="info" className="text-2xs shrink-0">
                  prompt
                </Badge>
              )}
            </span>
            {s.count > 0 && (
              <span className="tabular-nums text-xs text-faint shrink-0">{s.count.toLocaleString()}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A tag's cover in the list, or an empty square to keep rows aligned. */
function Thumb({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover bg-raised" />
  ) : (
    <span className="h-8 w-8 shrink-0 rounded bg-raised/60" />
  );
}
