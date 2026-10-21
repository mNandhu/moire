import { useState } from "react";
import { createPortal } from "react-dom";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Shirt } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button, DropdownMenu, type DropdownItem } from "../ui";
import { Dialog } from "../ui/Dialog";
import { useToast } from "../Toasts";
import { cn } from "../../lib/cn";
import { api } from "../../lib/api";
import {
  DEFAULT_OUTFIT,
  OUTFITS_KEY,
  defaultOutfitKey,
  fetchDefaultOutfit,
  outfitsKey,
  putDefaultCover,
  thumbUrl,
  updateOutfit,
  useCoverChoices,
  type CoverChoice,
  type Outfit,
} from "../../lib/generate";
import { displayName, type CharacterEntry } from "../../lib/character";
import { OutfitThumb } from "./Outfit";

/** Images the character wears an outfit in, most of its tags first; the
 * chosen one ringed. Each shows how many of the outfit's tags it has. */
export function CoverStrip({
  character,
  outfit,
  value,
  onChange,
}: {
  character: string;
  outfit: string;
  value: string | null;
  onChange: (imageId: string) => void;
}) {
  const { data, isLoading } = useCoverChoices(character, outfit);
  if (isLoading) return <span className="text-sm text-faint">Loading…</span>;
  // The current cover first, even when it isn't among the best matches.
  const listed = data ?? [];
  const now = listed.find((c) => c.image_id === value);
  const choices: (CoverChoice | { image_id: string; matched: null; of: number })[] = value
    ? [now ?? { image_id: value, matched: null, of: 0 }, ...listed.filter((c) => c.image_id !== value)]
    : listed;
  if (!choices.length) return <span className="text-sm text-faint">No images wear it</span>;
  return (
    <div className="flex gap-2 overflow-x-auto px-0.5 pb-1.5 pt-0.5">
      {choices.map((c) => {
        const on = c.image_id === value;
        return (
          <button
            key={c.image_id}
            type="button"
            onClick={() => onChange(c.image_id)}
            aria-pressed={on}
            title={c.matched == null ? "Its thumbnail now" : `Wears ${c.matched} of its ${c.of} tags`}
            className={cn(
              "relative h-[6.5rem] w-[4.5rem] shrink-0 overflow-hidden rounded-md border bg-raised",
              on ? "border-transparent ring-2 ring-brand-400" : "border-line hover:border-line-strong",
            )}
          >
            <img src={thumbUrl(c.image_id)} alt="" loading="lazy" className="h-full w-full object-cover" />
            {on && (
              <span className="absolute left-1 top-1 grid h-[18px] w-[18px] place-items-center rounded-full bg-brand-500 text-white">
                <Check size={11} strokeWidth={3} />
              </span>
            )}
            {c.matched != null && (
              <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 font-mono text-[10px] text-neutral-200">
                {c.matched}/{c.of}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Pick the cover of a character's Default outfit (their usual clothes), or
 * go back to the one picked for them. */
export function DefaultCoverDialog({
  open,
  onClose,
  outfit,
  characterName,
}: {
  open: boolean;
  onClose: () => void;
  outfit: Outfit;
  characterName: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pick, setPick] = useState<string | null>(outfit.image_id);
  const save = async (imageId: string | null) => {
    try {
      qc.setQueryData(defaultOutfitKey(outfit.character), await putDefaultCover(outfit.character, imageId));
      onClose();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't save", "error");
    }
  };
  return createPortal(
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-2xl"
      title={
        <span className="flex items-baseline gap-3">
          Default thumbnail<span className="text-sm font-normal text-muted">for {characterName}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2.5">
          {outfit.cover_picked && (
            <Button variant="ghost" onClick={() => void save(null)} title="Let Moiré pick the best-scored image wearing it">
              Pick automatically
            </Button>
          )}
          <Button variant="ghost" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!pick || pick === outfit.image_id} onClick={() => void save(pick)}>
            Save
          </Button>
        </div>
      }
    >
      <CoverStrip character={outfit.character} outfit={DEFAULT_OUTFIT} value={pick} onChange={setPick} />
    </Dialog>,
    document.body,
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
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const lists = useQueries({
    queries: characters.map((c) => ({
      queryKey: outfitsKey(c.tag),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Outfit[]>(`/api/v1/generate/outfits?character=${encodeURIComponent(c.tag)}`, { signal }),
    })),
  });
  const defs = useQueries({
    queries: characters.map((c) => ({
      queryKey: defaultOutfitKey(c.tag),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchDefaultOutfit(c.tag, signal),
      staleTime: 5 * 60_000,
    })),
  });
  const setCover = async (c: CharacterEntry, o: Outfit) => {
    try {
      if (o._id === DEFAULT_OUTFIT) qc.setQueryData(defaultOutfitKey(c.tag), await putDefaultCover(c.tag, imageId));
      else await updateOutfit(o._id, { image_id: imageId });
      void qc.invalidateQueries({ queryKey: OUTFITS_KEY });
      toast.push(`${o._id === DEFAULT_OUTFIT ? `${displayName(c).name}'s usual clothes` : o.name}: thumbnail changed`, "success");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't save", "error");
    }
  };
  const one = characters.length === 1;
  const items: DropdownItem[] = characters.flatMap((c, i) => {
    const name = displayName(c).name;
    const def = defs[i].data;
    // Their own: a shared one made for someone else keeps its cover.
    const list = lists[i].data;
    const own = Array.isArray(list) ? list.filter((o) => o.character === c.tag) : [];
    const outfits = [...(def?.tags?.length ? [def] : []), ...own];
    return [
      { label: one ? "Save as a new outfit" : `New outfit for ${name}`, group: one ? undefined : name, onClick: () => onSave(c) },
      ...outfits.map((o) => ({
        label: o._id === DEFAULT_OUTFIT ? "Default" : o.name,
        group: one ? "Use as thumbnail" : `${name}: use as thumbnail`,
        icon: (
          <OutfitThumb
            imageId={o.image_id}
            className={cn("h-[30px] w-[22px]", o._id === DEFAULT_OUTFIT && "outline-dashed outline-1 outline-line-strong")}
          />
        ),
        hint: o.image_id === imageId ? <span className="text-xs text-faint">this image</span> : undefined,
        onClick: () => void setCover(c, o),
      })),
      {
        label: one ? "All outfits" : `All of ${name}'s outfits`,
        // Under the thumbnails when there are some, else right after New.
        group: outfits.length ? (one ? "Use as thumbnail" : `${name}: use as thumbnail`) : one ? undefined : name,
        divider: outfits.length > 0,
        icon: <ArrowRight size={14} className="text-muted" />,
        onClick: () => navigate(`/outfits?character=${encodeURIComponent(c.tag)}`),
      },
    ];
  });
  return (
    <DropdownMenu
      variant="link"
      label={
        <>
          <Shirt size={12} /> Outfit
        </>
      }
      items={items}
    />
  );
}
