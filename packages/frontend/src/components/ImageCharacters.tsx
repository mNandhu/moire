import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import { TAGS_KEY } from "../lib/queries";
import { setTagThumbnail } from "../lib/imageMutations";
import { useToast } from "./Toasts";
import { formatTag, tagName } from "../lib/tags";
import { characterHref, displayName, type CharacterEntry } from "../lib/character";
import { CharacterAvatar } from "./CharacterAvatar";

/** Every character in the library; shared by the image view and character pages. */
export function useCharacters() {
  return useQuery({
    queryKey: [...TAGS_KEY, "characters"],
    queryFn: ({ signal }) => api<CharacterEntry[]>("/api/v1/tags/characters", { signal }),
    staleTime: 60_000,
  });
}

/** Every character by each of its names (a bare alias included). */
export function useCharacterLookup(): Map<string, CharacterEntry> {
  const { data } = useCharacters();
  return useMemo(
    () => new Map((data ?? []).flatMap((c) => [c.tag, ...c.aliases].map((n) => [n, c] as const))),
    [data],
  );
}

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
  const { data: characters } = useCharacters();
  const [pinning, setPinning] = useState<string | null>(null);
  const qc = useQueryClient();
  const { push } = useToast();
  const here = useMemo(() => {
    const names = new Set((tags ?? []).map(tagName));
    return (characters ?? []).filter((c) => [c.tag, ...c.aliases].some((n) => names.has(n)));
  }, [tags, characters]);
  if (!here.length) return null;

  const pinAvatar = async (c: CharacterEntry) => {
    setPinning(c.tag);
    try {
      await setTagThumbnail(c.tag, imageId);
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
      push(`Avatar set for ${displayName(c).name}`, "success");
    } catch (e) {
      push(`Couldn't change the avatar: ${String(e)}`, "error");
    } finally {
      setPinning(null);
    }
  };

  return (
    <section className="px-4 py-4 space-y-3">
      <h2 className="text-sm font-semibold">Characters</h2>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {here.map((c) => {
          const { name, series } = displayName(c);
          const isAvatar = c.thumb_image_id === imageId;
          const title = isAvatar
            ? "This image is their avatar"
            : quarantined
              ? "Quarantined images can't be avatars"
              : "Use as avatar";
          return (
            <div key={c.tag} className="group relative w-20">
              <Link
                to={characterHref(c.tag)}
                title={`${formatTag(c.tag)}: ${c.count.toLocaleString()} ${c.count === 1 ? "image" : "images"}`}
                className="flex flex-col items-center gap-1.5 text-center"
              >
                <CharacterAvatar
                  src={c.thumb_url}
                  face={c.face}
                  focus={c.focus}
                  aspect={c.aspect}
                  className="h-14 w-14 ring-1 ring-line group-hover:ring-brand-300"
                />
                <span className="w-full text-xs leading-tight text-neutral-200 line-clamp-2 break-words group-hover:text-white">
                  {name}
                </span>
                {series && (
                  <span className="-mt-1 w-full text-2xs leading-tight text-faint truncate">{series}</span>
                )}
              </Link>
              <button
                type="button"
                onClick={() => void pinAvatar(c)}
                disabled={isAvatar || quarantined || pinning !== null}
                aria-label={isAvatar ? `This image is ${name}'s avatar` : `Use as ${name}'s avatar`}
                title={title}
                className={cn(
                  "absolute right-1.5 top-0 h-6 w-6 rounded-full inline-flex items-center justify-center transition-opacity",
                  isAvatar
                    ? "bg-brand-500 text-white"
                    : "bg-black/70 text-white/85 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-0 disabled:group-hover:opacity-40",
                )}
              >
                <Pin size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
