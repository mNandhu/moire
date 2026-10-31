import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Pin } from "lucide-react";
import { cn } from "../lib/cn";
import { useCharacters } from "../lib/queries";
import { useToast } from "./Toasts";
import { formatTag, tagName } from "../lib/tags";
import { characterHref, displayName, type CharacterEntry } from "../lib/character";
import { CharacterAvatar } from "./CharacterAvatar";
import { Skeleton } from "./ui/Skeleton";
import { usePinCover } from "../hooks/usePinCover";
import { SaveOutfitDialog } from "./generate/SaveOutfitDialog";
import { OutfitMenu } from "./generate/OutfitMenu";
import { WornOutfits } from "./generate/WornOutfits";

/**
 * The characters in an image, the way a photo app shows the people in one:
 * each with their avatar and how many images they're in, linking to their
 * character page. The pin on an avatar makes this image their avatar
 * (not a quarantined one: avatars skip those). Nothing renders when the
 * image has none.
 */
export function ImageCharacters({
  imageId,
  tags,
  quarantined = false,
}: {
  imageId: string;
  tags: readonly string[] | undefined;
  quarantined?: boolean;
}) {
  const { data: characters, isPending } = useCharacters();
  const { pin } = usePinCover("avatar");
  // Which character's avatar is changing: one image, several characters.
  const [pinning, setPinning] = useState<string | null>(null);
  const { push } = useToast();
  // Whose outfit the save dialog is making.
  const [saving, setSaving] = useState<CharacterEntry | null>(null);
  const here = useMemo(() => {
    const names = new Set((tags ?? []).map(tagName));
    return (characters ?? []).filter((c) => [c.tag, ...c.aliases].some((n) => names.has(n)));
  }, [tags, characters]);
  const bases = useMemo(() => new Set((tags ?? []).map((t) => tagName(t).toLowerCase())), [tags]);
  const names = useMemo(() => new Map(here.map((c) => [c.tag, displayName(c).name])), [here]);
  // Until the list arrives, a placeholder where the people go (an image
  // without any loses it then).
  if (isPending && tags?.length) return <CharactersSkeleton />;
  if (!here.length) return null;

  const pinAvatar = async (c: CharacterEntry) => {
    if (pinning) return;
    setPinning(c.tag);
    try {
      if (await pin(c.tag, imageId)) push(`Avatar set for ${displayName(c).name}`, "success");
    } finally {
      setPinning(null);
    }
  };

  return (
    <section className="relative px-4 py-3 lg:py-4 space-y-3">
      {saving && (
        <SaveOutfitDialog
          open
          onClose={() => setSaving(null)}
          character={saving.tag}
          characterName={displayName(saving).name}
          imageId={imageId}
        />
      )}
      {/* Docked (lg), a photo app's people: a heading, then avatars over
          names. In the drawer, one row of avatars beside their names, the
          outfit menu at its end, to leave a phone's panel room for the rest. */}
      <div className="flex items-center gap-2 lg:flex-col lg:items-stretch lg:gap-3">
        <div className="flex items-center justify-between gap-2 max-lg:order-last max-lg:shrink-0">
          <h2 className="text-sm font-semibold max-lg:hidden">Characters</h2>
          <OutfitMenu imageId={imageId} characters={here} onSave={setSaving} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-3 max-lg:min-w-0 max-lg:flex-1 max-lg:gap-x-3 max-lg:gap-y-2">
          {here.map((c) => {
            const { name, series } = displayName(c);
            const isAvatar = c.thumb_image_id === imageId;
            const busy = pinning === c.tag;
            const title = isAvatar
              ? "This image is their avatar"
              : quarantined
                ? "Quarantined images can't be avatars"
                : "Use as avatar";
            return (
              <div key={c.tag} className="group relative w-20 max-lg:w-auto max-lg:max-w-[11rem]">
                <Link
                  to={characterHref(c.tag)}
                  title={`${formatTag(c.tag)}: ${c.count.toLocaleString()} ${c.count === 1 ? "image" : "images"}`}
                  className="flex flex-col items-center gap-1.5 text-center max-lg:flex-row max-lg:gap-2 max-lg:text-left"
                >
                  <span className="relative">
                    <CharacterAvatar
                      src={c.thumb_url}
                      face={c.face}
                      focus={c.focus}
                      aspect={c.aspect}
                      className={cn(
                        "h-14 w-14 max-lg:h-10 max-lg:w-10 shrink-0 ring-1 ring-line group-hover:ring-brand-300",
                        busy && "ring-2 ring-brand-400",
                      )}
                    />
                    {busy && (
                      <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                        <Loader2 size={18} className="animate-spin text-white" />
                      </span>
                    )}
                  </span>
                  <span className="flex w-full min-w-0 flex-col gap-0.5">
                    <span className="text-xs leading-tight text-neutral-200 line-clamp-2 max-lg:line-clamp-1 break-words group-hover:text-white">
                      {name}
                    </span>
                    {series && (
                      <span className="text-2xs leading-tight text-faint truncate">{series}</span>
                    )}
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => void pinAvatar(c)}
                  disabled={isAvatar || quarantined || pinning !== null}
                  aria-label={isAvatar ? `This image is ${name}'s avatar` : `Use as ${name}'s avatar`}
                  aria-busy={busy}
                  title={busy ? "Updating…" : title}
                  className={cn(
                    "absolute right-1.5 top-0 max-lg:right-auto max-lg:left-6 max-lg:-top-1.5 h-6 w-6 max-lg:h-5 max-lg:w-5 rounded-full inline-flex items-center justify-center transition-opacity",
                    isAvatar || busy
                      ? "bg-brand-500 text-white"
                      : "bg-black/70 text-white/85 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch:enabled:opacity-100 disabled:opacity-0 disabled:group-hover:opacity-40",
                  )}
                >
                  <Pin size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <WornOutfits
        // A new image starts folded to its first rows.
        key={imageId}
        imageId={imageId}
        characters={here.map((c) => c.tag)}
        imageTags={bases}
        characterName={(t) => names.get(t) ?? formatTag(t)}
      />
    </section>
  );
}

function CharactersSkeleton() {
  return (
    <section className="px-4 py-4 space-y-3" aria-busy="true" aria-label="Characters">
      <h2 className="text-sm font-semibold">Characters</h2>
      <div className="flex w-20 flex-col items-center gap-1.5">
        <Skeleton className="h-14 w-14 rounded-full" />
        <Skeleton className="h-3 w-14" />
      </div>
    </section>
  );
}
