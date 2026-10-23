import { useState } from "react";
import { useLocalPref } from "../../hooks/useLocalPref";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronUp } from "lucide-react";
import { Badge, Tooltip } from "../ui";
import { cn } from "../../lib/cn";
import { displayWord } from "../../lib/compose";
import { DEFAULT_OUTFIT, useWornOutfits, type WornOutfit } from "../../lib/generate";
import { outfitGalleryHref } from "../../lib/outfit";
import { OutfitThumb } from "./Outfit";

const KEY = "viewer:outfits-open";
// Rows shown before "N more".
const SHOWN = 3;


/** What a worn outfit's row says under its name. Pure. */
export function wornLine(o: WornOutfit, characterName: (tag: string) => string): string {
  if (o.thumbnail) return "Its thumbnail";
  const carried = `${o.carried} of ${o.of}`;
  return o._id === DEFAULT_OUTFIT ? `${characterName(o.character)} · wears ${carried}` : `Wears ${carried}`;
}

function TagsCard({ o, imageTags }: { o: WornOutfit; imageTags: ReadonlySet<string> }) {
  return (
    <div className="flex max-w-[16rem] flex-col gap-2 text-xs">
      <span className="font-medium text-neutral-50">{o.name}</span>
      <span className="flex flex-wrap gap-1">
        {o.tags.map((t) => (
          <span
            key={t.tag}
            className={cn(
              "rounded border border-line bg-raised px-1.5 py-px",
              // Only the tags the tagger can check count; the rest are dotted.
              !t.checkable ? "text-muted decoration-dotted underline" : imageTags.has(t.tag) ? "text-neutral-200" : "text-faint line-through",
            )}
          >
            {displayWord(t.tag)}
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * The bottom of the viewer's Characters section: a pill on its edge saying
 * which outfits the image wears, unfolding to a row each (click: the gallery
 * filtered to it). Nothing when it wears none. Open or folded is remembered.
 */
export function WornOutfits({
  imageId,
  characters,
  imageTags,
  characterName,
}: {
  imageId: string;
  characters: readonly string[];
  /** The image's tag bases, to strike the outfit tags it lacks. */
  imageTags: ReadonlySet<string>;
  characterName: (tag: string) => string;
}) {
  const { data } = useWornOutfits(imageId, characters, imageTags);
  const [open, setOpen] = useLocalPref(KEY, false);
  const [all, setAll] = useState(false);
  const worn = data ?? [];
  if (!worn.length) return null;
  const toggle = () => setOpen(!open);
  const rows = all ? worn : worn.slice(0, SHOWN);
  return (
    <>
      {open && (
        <div className="-mx-4 border-t border-dashed border-line px-4 pt-3">
          <div className="mb-1 text-2xs uppercase tracking-wider text-faint">Wearing</div>
          <div className="-mx-1.5 flex flex-col gap-0.5">
            {rows.map((o) => (
              <Tooltip key={o._id === DEFAULT_OUTFIT ? `default:${o.character}` : o._id} content={<TagsCard o={o} imageTags={imageTags} />} className="flex w-full">
                <Link
                  to={outfitGalleryHref(o)}
                  className="group/row flex w-full items-center gap-3 rounded-lg p-1.5 hover:bg-raised"
                >
                  <OutfitThumb
                    url={o.thumb_url}
                    className={cn("h-11 w-8 rounded-md", o._id === DEFAULT_OUTFIT && "outline-dashed outline-1 outline-line-strong")}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-neutral-50">
                      <span className="truncate">{o.name}</span>
                      {o.shared && <Badge tone="brand">Shared</Badge>}
                    </span>
                    <span className="text-xs text-muted">{wornLine(o, characterName)}</span>
                  </span>
                  <ArrowRight size={14} className="shrink-0 text-faint group-hover/row:text-neutral-100" />
                </Link>
              </Tooltip>
            ))}
          </div>
          {worn.length > SHOWN && !all && (
            <button type="button" onClick={() => setAll(true)} className="mt-1 text-xs text-muted hover:text-neutral-100">
              {worn.length - SHOWN} more
            </button>
          )}
        </div>
      )}
      {/* On the section's bottom edge, half over the rule below it. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? "Fold outfits" : "Outfits it wears"}
        className={cn(
          "absolute bottom-0 left-1/2 z-10 inline-flex h-6 -translate-x-1/2 translate-y-1/2 items-center gap-1.5 rounded-full border border-line-strong bg-raised text-2xs text-neutral-300 shadow-md hover:text-neutral-50",
          open ? "px-1.5" : "pl-1 pr-2",
        )}
      >
        {open ? (
          <ChevronUp size={13} />
        ) : (
          <>
            <span className="flex">
              {worn.slice(0, 3).map((o, i) => (
                <OutfitThumb
                  key={i}
                  url={o.thumb_url}
                  className={cn("h-[19px] w-3.5 rounded-[3px] ring-[1.5px] ring-raised", i > 0 && "-ml-1.5")}
                />
              ))}
            </span>
            <span className="max-w-[12rem] truncate">{worn.length === 1 ? worn[0].name : `${worn.length} outfits`}</span>
            <ChevronDown size={13} />
          </>
        )}
      </button>
    </>
  );
}
