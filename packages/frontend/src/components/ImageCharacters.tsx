import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TAGS_KEY } from "../lib/queries";
import { formatTag, tagName } from "../lib/tags";
import { characterHref, displayName, focusPosition, type CharacterEntry } from "../lib/character";

/** Every character in the library; shared by the image view and character pages. */
export function useCharacters() {
  return useQuery({
    queryKey: [...TAGS_KEY, "characters"],
    queryFn: ({ signal }) => api<CharacterEntry[]>("/api/v1/tags/characters", { signal }),
    staleTime: 60_000,
  });
}

/**
 * The characters in an image, the way a photo app shows the people in one:
 * each with their avatar and how many images they're in, linking to their
 * character page. Nothing renders when the image has none.
 */
export function ImageCharacters({ tags }: { tags: readonly string[] | undefined }) {
  const { data: characters } = useCharacters();
  const here = useMemo(() => {
    const names = new Set((tags ?? []).map(tagName));
    return (characters ?? []).filter((c) => [c.tag, ...c.aliases].some((n) => names.has(n)));
  }, [tags, characters]);
  if (!here.length) return null;

  return (
    <section className="px-4 py-4 space-y-3">
      <h2 className="text-sm font-semibold">Characters</h2>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {here.map((c) => {
          const { name, series } = displayName(c);
          return (
            <Link
              key={c.tag}
              to={characterHref(c.tag)}
              title={`${formatTag(c.tag)}: ${c.count.toLocaleString()} ${c.count === 1 ? "image" : "images"}`}
              className="group flex w-20 flex-col items-center gap-1.5 text-center"
            >
              <img
                src={c.thumb_url}
                alt=""
                loading="lazy"
                style={{ objectPosition: focusPosition(c.focus) }}
                className="h-14 w-14 rounded-full object-cover bg-raised ring-1 ring-line group-hover:ring-brand-300"
              />
              <span className="w-full text-xs leading-tight text-neutral-200 line-clamp-2 break-words group-hover:text-white">
                {name}
              </span>
              {series && (
                <span className="-mt-1 w-full text-2xs leading-tight text-faint truncate">{series}</span>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
