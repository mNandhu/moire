import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { FaceCrop } from "@/features/characters/components/CharacterAvatar";
import { useCharacters } from "@/features/characters/lib/queries";
import { characterHref, displayName, type CharacterEntry } from "@/features/characters/lib/character";
import { DiscoverSection, SHELF } from "@/features/discover/components/DiscoverSection";
import { useCharactersMade } from "@/features/overview/lib/queries";

const DAYS = 30;
const SHOWN = 12;
// One character is a banner's job, not a shelf's.
const MIN_SHOWN = 2;
const TILE =
  "group relative block aspect-[4/5] w-32 shrink-0 snap-start overflow-hidden rounded-xl bg-white/[0.06] shadow-tile ring-brand-400 focus-visible:outline-none focus-visible:ring-2 sm:w-36";
// The tile's width / height, for the face crop.
const FRAME = 4 / 5;

// How many showed last time: a shelf too small then stays hidden while it
// loads again, rather than holding placeholders and vanishing.
let lastShown: number | null = null;

/** Local midnight `days` ago (today counted) from `today` (a
 * `toDateString()`), in epoch seconds. */
function daysAgo(days: number, today: string): number {
  const d = new Date(today);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days + 1).getTime() / 1000;
}

/**
 * Who the last 30 days were spent on: the characters in the images made
 * then, most first, each with how many and the way to their page.
 */
export function CharactersLately() {
  // From today's date, so a page left open past midnight moves with it.
  const today = new Date().toDateString();
  const since = useMemo(() => daysAgo(DAYS, today), [today]);
  const made = useCharactersMade(since, null, SHOWN);
  const characters = useCharacters();
  const pending = made.isPending || characters.isPending;
  const rows = useMemo(() => {
    if (!made.data || !characters.data) return undefined;
    const by = new Map(characters.data.map((c) => [c.tag, c]));
    return made.data.flatMap((m) => {
      const c = by.get(m.tag);
      return c ? [{ c, count: m.count }] : [];
    });
  }, [made.data, characters.data]);
  useEffect(() => {
    if (rows) lastShown = rows.length;
  }, [rows]);
  if (pending ? (lastShown ?? MIN_SHOWN) < MIN_SHOWN : (rows?.length ?? 0) < MIN_SHOWN) return null;

  return (
    <DiscoverSection
      label="Who you've been making"
      icon={Users}
      tint="rose"
      cover={rows?.[0]?.c.thumb_url}
      actions={<span className="hidden text-sm text-muted sm:inline">Last {DAYS} days</span>}
    >
      <div className={SHELF}>
        {!rows
          ? Array.from({ length: Math.min(SHOWN, lastShown ?? 6) }, (_, i) => <Skeleton key={i} className={TILE} />)
          : rows.map(({ c, count }) => <CharacterTile key={c.tag} c={c} count={count} />)}
      </div>
    </DiscoverSection>
  );
}

function CharacterTile({ c, count }: { c: CharacterEntry; count: number }) {
  const { name, series } = displayName(c);
  return (
    <Link to={characterHref(c.tag)} className={TILE}>
      <FaceCrop
        src={c.thumb_url}
        face={c.face}
        focus={c.focus}
        aspect={c.aspect}
        frame={FRAME}
        zoom={3}
        letter={name}
        className="h-full w-full bg-transparent transition-transform duration-200 group-hover:scale-[1.03]"
      />
      {c.color && (
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1/2 opacity-50"
          style={{ background: `linear-gradient(to top, ${c.color}, transparent)` }}
        />
      )}
      <span className="absolute right-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-rose-100 backdrop-blur-sm">
        {count.toLocaleString()}
      </span>
      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2.5 pb-2 pt-10">
        <span className="line-clamp-2 text-sm font-semibold leading-snug text-neutral-50">{name}</span>
        {series && <span className="block truncate text-2xs text-neutral-300">{series}</span>}
      </span>
    </Link>
  );
}
