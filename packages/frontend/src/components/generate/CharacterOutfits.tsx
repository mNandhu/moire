import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Images } from "lucide-react";
import { Badge } from "../ui";
import { useToast } from "../Toasts";
import { cn } from "../../lib/cn";
import {
  DEFAULT_OUTFIT,
  OUTFITS_KEY,
  hideOutfit,
  useDefaultOutfit,
  useOutfits,
  type Outfit,
} from "../../lib/generate";
import { outfitGalleryHref } from "../../lib/outfit";
import { OutfitThumb } from "./Outfit";
import { SaveOutfitDialog } from "./SaveOutfitDialog";

function Mini({
  o,
  character,
  onOpen,
  onHide,
}: {
  o: Outfit;
  character: string;
  onOpen?: () => void;
  onHide?: () => void;
}) {
  const isDefault = o._id === DEFAULT_OUTFIT;
  const foreign = o.shared && o.character !== character;
  return (
    <div
      className={cn(
        "group flex w-[8.25rem] shrink-0 flex-col gap-1.5 rounded-xl border bg-surface p-1.5",
        isDefault ? "border-dashed border-line-strong" : "border-line hover:border-line-strong",
        onOpen && "cursor-pointer",
        o.hidden && "opacity-50",
      )}
      onClick={(e) => {
        if (onOpen && !(e.target as HTMLElement).closest("a, button")) onOpen();
      }}
    >
      <div className="relative h-[9.5rem] overflow-hidden rounded-md bg-raised">
        <OutfitThumb imageId={o.image_id} className="h-full w-full rounded-none" />
        <Link
          to={outfitGalleryHref(o, character)}
          title="Open in gallery"
          aria-label={`Open ${o.name} in gallery`}
          className="absolute bottom-1.5 left-1.5 grid h-7 w-7 place-items-center rounded-lg border border-line-strong bg-surface/90 text-neutral-100 opacity-0 transition-opacity hover:bg-raised group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Images size={13} />
        </Link>
        {foreign && onHide && (
          <button
            type="button"
            onClick={onHide}
            title={o.hidden ? "Show in this character's list" : "Hide from this character's list"}
            aria-label={o.hidden ? `Show ${o.name}` : `Hide ${o.name}`}
            className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg border border-line-strong bg-surface/90 text-neutral-100 opacity-0 transition-opacity hover:bg-raised group-hover:opacity-100 focus-visible:opacity-100"
          >
            {o.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        )}
      </div>
      <span className="truncate px-0.5 text-sm text-neutral-100" title={o.name}>
        {o.name}
      </span>
      <span className="px-0.5 text-xs text-muted">
        {isDefault ? (
          `usual clothes, from ${o.images?.toLocaleString() ?? 0} images`
        ) : foreign ? (
          <Badge tone="brand">Shared</Badge>
        ) : (
          `${o.tags.length} ${o.tags.length === 1 ? "tag" : "tags"}`
        )}
      </span>
    </div>
  );
}

/**
 * The character page's Outfits strip: the computed Default first, the
 * character's own outfits, then shared ones (each hideable for this
 * character). A card opens the outfit to edit; "All outfits" goes to the
 * Outfits page filtered to them.
 */
export function CharacterOutfits({ character, name }: { character: string; name: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: def } = useDefaultOutfit(character);
  const { data: list } = useOutfits(character);
  const [editing, setEditing] = useState<Outfit | null>(null);
  const hide = useMutation({
    mutationFn: (o: Outfit) => hideOutfit(o._id, character, !o.hidden),
    onSuccess: () => void qc.invalidateQueries({ queryKey: OUTFITS_KEY }),
    onError: (e) => toast.push(e.message, "error"),
  });
  const own = (list ?? []).filter((o) => o.character === character);
  const shared = (list ?? []).filter((o) => o.character !== character);
  const d = def && def.tags.length ? def : null;
  if (!d && !own.length && !shared.length) return null;
  const counts = [own.length && `${own.length} own`, shared.length && `${shared.length} shared`].filter(Boolean).join(", ");
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 className="text-2xs uppercase tracking-wider text-faint">Outfits · {own.length + shared.length}</h2>
        {counts && <span className="text-xs text-muted">{counts}</span>}
        <Link to={`/outfits?character=${encodeURIComponent(character)}`} className="ml-auto text-xs text-brand-300 hover:text-brand-200">
          All outfits
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {d && <Mini o={d} character={character} />}
        {own.map((o) => (
          <Mini key={o._id} o={o} character={character} onOpen={() => setEditing(o)} />
        ))}
        {shared.map((o) => (
          <Mini key={o._id} o={o} character={character} onOpen={() => setEditing(o)} onHide={() => hide.mutate(o)} />
        ))}
      </div>
      {editing && (
        <SaveOutfitDialog
          open
          onClose={() => setEditing(null)}
          character={editing.character}
          characterName={editing.character === character ? name : editing.character}
          imageId={editing.image_id}
          outfit={editing}
        />
      )}
    </section>
  );
}
