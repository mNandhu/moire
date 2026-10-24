// Outfit reads and actions shared by the Generate screen, the character page,
// the Outfits page and the image viewer's Outfit menu.

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Images, Pencil, Wand2 } from "lucide-react";
import type { DropdownItem } from "../components/ui";
import { useToast } from "../components/Toasts";
import {
  DEFAULT_OUTFIT,
  OUTFITS_KEY,
  defaultOutfitKey,
  defaultOutfitQuery,
  hideOutfit,
  outfitsQuery,
  putDefaultOutfit,
  updateOutfit,
  useDefaultOutfit,
  useOutfits,
  type Outfit,
} from "../lib/generate";
import { loadDraft, saveDraft, wearingOutfit } from "../lib/generateForm";
import { outfitGalleryHref, pickOf } from "../lib/outfit";

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

/** A character's outfit list for pickers: Default first, their own, then
 * the shared ones they don't hide. */
export function useCharacterOutfits(character: string) {
  const { data: def } = useDefaultOutfit(character);
  const { data: list } = useOutfits(character);
  return useMemo(() => {
    const visible = (list ?? []).filter((o) => !o.hidden);
    const d = def && def.tags.length ? def : null;
    const own = visible.filter((o) => o.character === character);
    const shared = visible.filter((o) => o.character !== character);
    // Attire group per tag, from every outfit in the list.
    const groups = new Map<string, string | null>();
    for (const o of [...(d ? [d] : []), ...own, ...shared]) for (const t of o.tags) groups.set(t.tag, t.group);
    return { def: d, own, shared, groups };
  }, [character, def, list]);
}

/** The outfits the viewer's Outfit menu offers per character, in order:
 * their Default (when it has tags) and their own (a shared one made for
 * someone else keeps its cover). Loaded only while `enabled`. */
export function useOutfitMenuData(characters: readonly { tag: string }[], enabled: boolean) {
  const lists = useQueries({ queries: characters.map((c) => ({ ...outfitsQuery(c.tag), enabled })) });
  const defs = useQueries({ queries: characters.map((c) => ({ ...defaultOutfitQuery(c.tag), enabled })) });
  return characters.map((c, i) => {
    const def = defs[i].data;
    const list = lists[i].data;
    const own = Array.isArray(list) ? list.filter((o) => o.character === c.tag) : [];
    return [...(def?.tags?.length ? [def] : []), ...own];
  });
}

/** Makes `imageId` the thumbnail of an outfit (Default included); toasts
 * the outcome. */
export function useSetOutfitCover(imageId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (character: string, o: Outfit) => {
    try {
      if (o._id === DEFAULT_OUTFIT) qc.setQueryData(defaultOutfitKey(character), await putDefaultOutfit(character, { image_id: imageId }));
      else await updateOutfit(o._id, { image_id: imageId });
      void qc.invalidateQueries({ queryKey: OUTFITS_KEY });
      toast.push(`${o.name}: thumbnail changed`, "success");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't save", "error");
    }
  };
}
