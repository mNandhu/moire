import { Badge } from "./ui/Badge";
import { cn } from "../lib/cn";
import { formatSearchTag, isManual, isPrompt } from "../lib/tags";
import { resourceLabel, type TagSuggestion } from "../lib/tagSuggest";
import { smallThumb } from "../lib/media";

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
  descriptionOf,
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
  /** The tag's one-sentence description, shown under its name. */
  descriptionOf?: (id: string) => string | undefined;
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
      {matches.map((s, i) => {
        const description = descriptionOf?.(s._id);
        return (
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
                <span className="min-w-0">
                  <span className="flex items-center gap-2 min-w-0">
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
                  {description && <span className="line-clamp-2 text-xs leading-snug text-muted">{description}</span>}
                </span>
              </span>
              {s.count > 0 && (
                <span className="tabular-nums text-xs text-faint shrink-0">{s.count.toLocaleString()}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** A tag's cover in the list, or an empty square to keep rows aligned. */
function Thumb({ url }: { url: string | null }) {
  return url ? (
    <img src={smallThumb(url)} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover bg-raised" />
  ) : (
    <span className="h-8 w-8 shrink-0 rounded bg-raised/60" />
  );
}
