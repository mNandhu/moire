import { useState } from "react";
import { useThumbUrl } from "../../lib/queries";
import { ArrowRight, Check, Shirt } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DropdownMenu, type DropdownItem } from "../ui";
import { cn } from "../../lib/cn";
import {
  DEFAULT_OUTFIT,
  useCoverChoices,
  type CoverChoice,
} from "../../lib/generate";
import { displayName, type CharacterEntry } from "../../lib/character";
import { displayWord } from "../../lib/compose";
import { OutfitThumb } from "./Outfit";
import { useOutfitMenuData, useSetOutfitCover } from "../../hooks/useOutfitData";
import { outfitsHref } from "../../lib/outfit";

/** What a cover choice lacks of the outfit, as its caption. Pure. */
export function coverCaption(missing: readonly string[]): string {
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

/**
 * The viewer's Outfit menu, per character in the image: save a new outfit
 * from it, or make it the thumbnail of one they have (Default included).
 */
export function OutfitMenu({
  imageId,
  characters,
  onSave,
}: {
  imageId: string;
  characters: readonly CharacterEntry[];
  onSave: (c: CharacterEntry) => void;
}) {
  const navigate = useNavigate();
  // Loaded when the menu opens: the viewer shows this for every image.
  const [open, setOpen] = useState(false);
  const menu = useOutfitMenuData(characters, open);
  const setCover = useSetOutfitCover(imageId);
  const one = characters.length === 1;
  const items: DropdownItem[] = characters.flatMap((c, i) => {
    const name = displayName(c).name;
    const outfits = menu[i];
    return [
      { label: one ? "Save as a new outfit" : `New outfit for ${name}`, group: one ? undefined : name, onClick: () => onSave(c) },
      ...outfits.map((o) => ({
        label: o.name,
        group: one ? "Use as thumbnail" : `${name}: use as thumbnail`,
        icon: (
          <OutfitThumb
            url={o.thumb_url}
            className={cn("h-[30px] w-[22px]", o._id === DEFAULT_OUTFIT && "outline-dashed outline-1 outline-line-strong")}
          />
        ),
        hint: o.image_id === imageId ? <span className="text-xs text-faint">this image</span> : undefined,
        onClick: () => void setCover(c.tag, o),
      })),
      {
        label: one ? "All outfits" : `All of ${name}'s outfits`,
        // Under the thumbnails when there are some, else right after New.
        group: outfits.length ? (one ? "Use as thumbnail" : `${name}: use as thumbnail`) : one ? undefined : name,
        divider: outfits.length > 0,
        icon: <ArrowRight size={14} className="text-muted" />,
        onClick: () => navigate(outfitsHref(c.tag)),
      },
    ];
  });
  return (
    <DropdownMenu
      variant="link"
      onOpenChange={setOpen}
      label={
        <>
          <Shirt size={12} /> Outfit
        </>
      }
      items={items}
    />
  );
}
