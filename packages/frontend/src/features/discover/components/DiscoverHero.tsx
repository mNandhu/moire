import { UserRound } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { formatTag } from "@/features/tags/lib/tags";
import { characterHref, type CharacterEntry } from "@/features/characters/lib/character";
import type { BannerPicture } from "@/features/discover/lib/discover";
import { Banner } from "@/features/discover/components/Banner";

/**
 * Discover's banner: one character, a picture of them (their avatar framed
 * on the face the detector found or the point the user set, else a
 * landscape image of theirs when there is one), their name, and the way to
 * their page.
 */
export function DiscoverHero({
  character,
  picture,
  children,
}: {
  /** Undefined while the characters load. */
  character: CharacterEntry | undefined;
  /** What the banner shows (see `bannerPicture`); undefined while it's chosen. */
  picture: BannerPicture | undefined;
  /** Under the banner, on its light: a shelf of the character's images. */
  children?: React.ReactNode;
}) {
  const name = character ? (character.name ?? formatTag(character.tag)) : "";
  return (
    <Banner
      label="Featured character"
      picture={picture}
      glowSrc={character?.thumb_url}
      color={character?.color}
      text={
        character && (
          <div className="min-w-0">
            {character.series && <p className="truncate text-sm font-medium text-neutral-300">{character.series}</p>}
            <h2 className="line-clamp-2 text-4xl font-semibold leading-[1.05] tracking-tight text-neutral-50 sm:text-5xl">
              {name}
            </h2>
            <p className="mt-1.5 text-sm tabular-nums text-neutral-300">
              {character.count.toLocaleString()} {character.count === 1 ? "image" : "images"}
            </p>
          </div>
        )
      }
      actions={
        character && (
          <ButtonLink variant="primary" to={characterHref(character.tag)}>
            <UserRound size={16} /> Open character
          </ButtonLink>
        )
      }
    >
      {children}
    </Banner>
  );
}
