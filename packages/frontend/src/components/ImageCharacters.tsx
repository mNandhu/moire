import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TAGS_KEY } from "../lib/queries";
import { formatTag, tagName } from "../lib/tags";

type Character = { tag: string; count: number; thumb_url: string };

/** "nahida (genshin impact)" as the name and the series it's from. */
export function characterName(tag: string): { name: string; series: string | null } {
  const shown = formatTag(tag);
  const m = /^(.+?) \((.+)\)$/.exec(shown);
  return m ? { name: m[1], series: m[2] } : { name: shown, series: null };
}

/**
 * The characters in an image, the way a photo app shows the people in one:
 * each with their cover and how many images they're in, linking to their
 * page on the Tags page. Nothing renders when the image has none.
 */
export function ImageCharacters({ tags }: { tags: readonly string[] | undefined }) {
  const { data: characters } = useQuery({
    queryKey: [...TAGS_KEY, "characters"],
    queryFn: ({ signal }) => api<Character[]>("/api/v1/tags/characters", { signal }),
    staleTime: 60_000,
  });
  const here = useMemo(() => {
    const names = new Set((tags ?? []).map(tagName));
    return (characters ?? []).filter((c) => names.has(c.tag));
  }, [tags, characters]);
  if (!here.length) return null;

  return (
    <section className="px-4 py-4 space-y-3">
      <h2 className="text-sm font-semibold">Characters</h2>
      <div className="flex flex-wrap gap-x-4 gap-y-3">
        {here.map((c) => (
          <Link
            key={c.tag}
            to={`/tags?${new URLSearchParams({ tag: c.tag })}`}
            title={`${formatTag(c.tag)}: ${c.count.toLocaleString()} ${c.count === 1 ? "image" : "images"}`}
            className="group flex w-20 flex-col items-center gap-1.5 text-center"
          >
            <img
              src={c.thumb_url}
              alt=""
              loading="lazy"
              className="h-14 w-14 rounded-full object-cover bg-raised ring-1 ring-line group-hover:ring-brand-300"
            />
            <span className="w-full text-xs leading-tight text-neutral-200 line-clamp-2 break-words group-hover:text-white">
              {characterName(c.tag).name}
            </span>
            {characterName(c.tag).series && (
              <span className="-mt-1 w-full text-2xs leading-tight text-faint truncate">
                {characterName(c.tag).series}
              </span>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
