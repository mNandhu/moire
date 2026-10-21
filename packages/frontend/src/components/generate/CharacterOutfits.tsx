import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Images, Pencil, Plus, Wand2 } from "lucide-react";
import { Badge, DropdownMenu, type DropdownItem } from "../ui";
import { useToast } from "../Toasts";
import { cn } from "../../lib/cn";
import { displayWord } from "../../lib/compose";
import {
  DEFAULT_OUTFIT,
  OUTFITS_KEY,
  hideOutfit,
  useDefaultOutfit,
  useOutfits,
  type Outfit,
} from "../../lib/generate";
import { loadDraft, saveDraft, wearingOutfit } from "../../lib/generateForm";
import { outfitGalleryHref, pickOf } from "../../lib/outfit";
import { OutfitThumb } from "./Outfit";
import { SaveOutfitDialog } from "./SaveOutfitDialog";

/** What a click on an outfit card offers: edit it, wear it in Generate,
 * see it in the gallery, and for a shared one, hide it for this character. */
export function useOutfitActions(character: string, characterName: string) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const hide = useMutation({
    mutationFn: (o: Outfit) => hideOutfit(o._id, character, !o.hidden),
    onSuccess: () => void qc.invalidateQueries({ queryKey: OUTFITS_KEY }),
    onError: (e) => toast.push(e.message, "error"),
  });
  return (o: Outfit, onEdit: () => void, { canHide = false } = {}): DropdownItem[] => [
    { label: "Edit tags and thumbnail", icon: <Pencil size={14} />, onClick: onEdit },
    {
      label: "Use in Generate",
      icon: <Wand2 size={14} />,
      onClick: () => {
        saveDraft(wearingOutfit(loadDraft(), character, pickOf(o)));
        navigate("/generate");
      },
    },
    { label: "Open in gallery", icon: <Images size={14} />, onClick: () => navigate(outfitGalleryHref(o, character)) },
    ...(canHide
      ? [
          {
            label: o.hidden ? `Show for ${characterName}` : `Hide for ${characterName}`,
            icon: o.hidden ? <Eye size={14} /> : <EyeOff size={14} />,
            divider: true,
            onClick: () => hide.mutate(o),
          },
        ]
      : []),
  ];
}

function Mini({ o, character }: { o: Outfit; character: string }) {
  const isDefault = o._id === DEFAULT_OUTFIT;
  const foreign = o.shared && o.character !== character;
  const shown = o.tags.slice(0, 3);
  return (
    <div
      className={cn(
        "flex w-[9.25rem] shrink-0 flex-col gap-1.5 rounded-xl border bg-surface p-1.5 hover:border-line-strong",
        isDefault ? "border-dashed border-line-strong" : "border-line",
        o.hidden && "opacity-50",
      )}
    >
      <div className="h-[10.5rem] overflow-hidden rounded-md bg-raised">
        <OutfitThumb imageId={o.image_id} className="h-full w-full rounded-none" />
      </div>
      <span className="flex min-w-0 items-center gap-1.5 px-0.5 text-sm text-neutral-100">
        <span className="truncate" title={o.name}>
          {o.name}
        </span>
        {isDefault && (
          <span className="shrink-0 rounded-full border border-line-strong px-1.5 text-[10.5px] text-muted">
            {o.edited ? "usual, edited" : "usual"}
          </span>
        )}
        {foreign && <Badge tone="brand">Shared</Badge>}
      </span>
      <span className="flex flex-wrap gap-1 px-0.5">
        {shown.map((t) => (
          <span key={t.tag} className="rounded-full border border-line bg-raised px-1.5 py-px text-[11px] text-neutral-300">
            {displayWord(t.tag)}
          </span>
        ))}
        {o.tags.length > shown.length && (
          <span className="rounded-full border border-line bg-raised px-1.5 py-px text-[11px] text-neutral-300">
            +{o.tags.length - shown.length}
          </span>
        )}
        {!o.tags.length && <span className="text-xs text-faint">No tags</span>}
      </span>
    </div>
  );
}

/**
 * The character page's Outfits strip: Default (their usual clothes, editable
 * and renamable) first, the character's own outfits, then shared ones. A
 * click on a card opens its actions; "All outfits" goes to the Outfits page
 * filtered to them.
 */
export function CharacterOutfits({ character, name }: { character: string; name: string }) {
  const { data: def } = useDefaultOutfit(character);
  const { data: list } = useOutfits(character);
  const [editing, setEditing] = useState<Outfit | null>(null);
  const [creating, setCreating] = useState(false);
  const actions = useOutfitActions(character, name);
  const own = (list ?? []).filter((o) => o.character === character);
  const shared = (list ?? []).filter((o) => o.character !== character);
  // Default shows even when empty once edited: it may have been emptied by hand.
  const d = def && (def.tags.length || def.edited) ? def : null;
  const counts = [own.length && `${own.length} own`, shared.length && `${shared.length} shared`].filter(Boolean).join(", ");
  const card = (o: Outfit, canHide = false) => (
    <DropdownMenu
      key={o._id}
      aria-label={`${o.name} actions`}
      trigger={<Mini o={o} character={character} />}
      items={actions(o, () => setEditing(o), { canHide })}
    />
  );
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2.5">
        <h2 className="text-2xs uppercase tracking-wider text-faint">Outfits · {own.length + shared.length}</h2>
        {counts && <span className="text-xs text-muted">{counts}</span>}
        <span className="ml-auto flex items-center gap-4">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
          >
            <Plus size={12} /> New outfit
          </button>
          <Link to={`/outfits?character=${encodeURIComponent(character)}`} className="text-xs text-brand-300 hover:text-brand-200">
            All outfits
          </Link>
        </span>
      </div>
      <div className="flex flex-wrap gap-3 pb-1">
        {!d && !own.length && !shared.length && <span className="text-sm text-faint">No outfits yet</span>}
        {d && card(d)}
        {own.map((o) => card(o))}
        {shared.map((o) => card(o, true))}
      </div>
      {creating && (
        <SaveOutfitDialog open onClose={() => setCreating(false)} character={character} characterName={name} imageId={null} />
      )}
      {editing && (
        <SaveOutfitDialog
          open
          onClose={() => setEditing(null)}
          character={editing._id === DEFAULT_OUTFIT ? character : editing.character}
          characterName={editing.character === character ? name : displayWord(editing.character)}
          imageId={editing.image_id}
          outfit={editing._id === DEFAULT_OUTFIT ? (def ?? editing) : editing}
        />
      )}
    </section>
  );
}
