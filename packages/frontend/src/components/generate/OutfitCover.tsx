import { useState } from "react";
import { useThumbUrl } from "../../lib/queries";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";
import { useCoverChoices, type CoverChoice } from "../../lib/generate";
import { displayWord } from "../../lib/compose";

/** What a cover choice lacks of the outfit, as its caption. Pure. */
function coverCaption(missing: readonly string[]): string {
  return missing.length ? `no ${missing.map(displayWord).join(", ")}` : "wears all";
}

/**
 * The cover picker: the character's images wearing most of the outfit, in a
 * grid, each captioned with the outfit tags it lacks; the current one first
 * and ringed. "Wears all" keeps only complete matches.
 */
export function CoverGrid({
  character,
  outfit,
  tags,
  value,
  onChange,
}: {
  character: string;
  outfit: string;
  /** An outfit not saved yet: its tags so far, in place of `outfit`. */
  tags?: readonly string[];
  value: string | null;
  onChange: (imageId: string) => void;
}) {
  const { data, isLoading } = useCoverChoices(character, outfit, tags);
  const [all, setAll] = useState(false);
  const listed = data ?? [];
  // The current cover first, even when it isn't among the best matches.
  const now = listed.find((c) => c.image_id === value);
  const valueUrl = useThumbUrl(isLoading || now ? null : value);
  if (isLoading) return <span className="text-sm text-faint">Loading…</span>;
  const rest = listed.filter((c) => c.image_id !== value && (!all || !c.missing.length));
  const choices: (CoverChoice | { image_id: string; thumb_url: string | null; missing: null })[] = value
    ? [now ?? { image_id: value, thumb_url: valueUrl, missing: null }, ...rest]
    : rest;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg border border-line p-0.5">
          {([false, true] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={all === v}
              onClick={() => setAll(v)}
              className={cn("rounded-md px-2.5 py-1 text-xs", all === v ? "bg-raised text-neutral-100" : "text-muted hover:text-neutral-100")}
            >
              {v ? "Wears all" : "Best matches"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted">
          {listed.length} {listed.length === 1 ? "image wears" : "images wear"} some of it
        </span>
      </div>
      {!choices.length ? (
        <span className="text-sm text-faint">{all ? "No images wear all of it" : "No images wear any of it"}</span>
      ) : (
        <div className="grid max-h-[22rem] grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] gap-2 overflow-y-auto p-0.5">
          {choices.map((c) => {
            const on = c.image_id === value;
            return (
              <button
                key={c.image_id}
                type="button"
                onClick={() => onChange(c.image_id)}
                aria-pressed={on}
                className={cn(
                  "relative aspect-[2/3] overflow-hidden rounded-md border bg-raised",
                  on ? "border-transparent ring-2 ring-brand-400" : "border-line hover:border-line-strong",
                )}
              >
                {c.thumb_url && <img src={c.thumb_url} alt="" loading="lazy" className="h-full w-full object-cover" />}
                {on && (
                  <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-brand-500 text-white">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
                {c.missing && (
                  <span
                    className={cn(
                      "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-1.5 pb-1 pt-4 text-left text-[10.5px] leading-tight",
                      c.missing.length ? "text-neutral-200" : "text-emerald-200",
                    )}
                  >
                    {coverCaption(c.missing)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
