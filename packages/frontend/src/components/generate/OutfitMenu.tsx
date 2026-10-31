import { useState } from "react";
import { ArrowRight, Shirt } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DropdownMenu, type DropdownItem } from "../ui";
import { cn } from "../../lib/cn";
import { DEFAULT_OUTFIT } from "../../lib/generate";
import { displayName, type CharacterEntry } from "../../lib/character";
import { OutfitThumb } from "./Outfit";
import { useOutfitMenuData, useSetOutfitCover } from "../../hooks/useOutfitData";
import { outfitsHref } from "../../lib/outfit";

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
