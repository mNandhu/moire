import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import { withBackgroundLocation } from "@/lib/backgroundLocation";
import { stepsState } from "@/lib/stepList";
import { imageHref, type FeedItem, type Filters } from "@/features/images/lib/imageFilter";
import { STRIP_SIZE } from "@/features/discover/lib/queries";
import { blurhashDataUrl } from "@/lib/blurhash";

/** Each section's colour: its badge, and the light it casts. */
const TINTS = {
  sky: { badge: "bg-sky-400/15 text-sky-300 ring-sky-400/30", glow: "from-sky-500/25" },
  amber: { badge: "bg-amber-400/15 text-amber-300 ring-amber-400/30", glow: "from-amber-500/25" },
  rose: { badge: "bg-rose-400/15 text-rose-300 ring-rose-400/30", glow: "from-rose-500/25" },
  emerald: { badge: "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30", glow: "from-emerald-500/25" },
  cyan: { badge: "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30", glow: "from-cyan-500/25" },
  violet: { badge: "bg-brand-400/15 text-brand-200 ring-brand-400/30", glow: "from-brand-500/25" },
  fuchsia: { badge: "bg-fuchsia-400/15 text-fuchsia-300 ring-fuchsia-400/30", glow: "from-fuchsia-500/25" },
} as const;
type Tint = keyof typeof TINTS;

/** A row of tiles that scrolls sideways (images and tag cards alike), by
 * trackpad, swipe, Shift+wheel or keyboard, with no scrollbar. */
export const SHELF = "flex gap-3 overflow-x-auto pb-2 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * A Discover section: a box lit by its own pick (a blurred, enlarged copy of
 * its first image), its title with an icon and a way to see all of it.
 */
export function DiscoverSection({
  label,
  title = label,
  icon: Icon,
  badge,
  tint = "violet",
  cover,
  viewAll,
  actions,
  className,
  children,
}: {
  /** The section's name (its region's, and the title unless one is given). */
  label: string;
  title?: React.ReactNode;
  icon?: LucideIcon;
  /** In place of the icon (a character's avatar). */
  badge?: React.ReactNode;
  tint?: Tint;
  /** An image of the pick, the section's light. */
  cover?: string | null;
  /** Where "View all" goes; none, no link. */
  viewAll?: string;
  /** Beside "View all": the section's own controls. */
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "relative isolate overflow-hidden rounded-2xl border border-white/5 bg-surface p-4 shadow-panel sm:p-5",
        className,
      )}
    >
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 h-full w-full scale-125 object-cover opacity-35 blur-3xl saturate-150"
        />
      )}
      <div className={cn("pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br to-surface/90", TINTS[tint].glow)} />
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2.5 text-xl font-semibold tracking-tight text-neutral-50">
          {badge ??
            (Icon && (
              <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1", TINTS[tint].badge)}>
                <Icon size={18} strokeWidth={2.2} />
              </span>
            ))}
          <span className="min-w-0 truncate">{title}</span>
        </h2>
        {actions}
        {viewAll && (
          <Link
            to={viewAll}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted hover:text-neutral-100"
          >
            View all <ArrowRight size={14} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** A shelf image: its blurhash in the tile's first paint (never a dark tile
 * first), the image fading in over it. */
export function ShelfImage({ src, blurhash }: { src: string; blurhash: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const blur = useMemo(() => (blurhash ? blurhashDataUrl(blurhash) : null), [blurhash]);
  return (
    <>
      {blur && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${blur})` }}
        />
      )}
      <img
        // A cached image can be complete before the load handler is on.
        ref={(el) => {
          if (el?.complete && el.naturalWidth) setLoaded(true);
        }}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        className={cn(
          "relative h-full w-full object-cover transition-[opacity,transform] duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </>
  );
}

// A faint glass tile, not a dark one, under the blurhash and as the
// placeholder: on a lit box a black tile reads as a black image.
const TILE =
  "relative block aspect-[3/4] shrink-0 snap-start overflow-hidden rounded-xl bg-white/[0.06] shadow-tile ring-brand-400 focus-visible:outline-none focus-visible:ring-2";
const TILE_WIDTH = { md: "w-40 sm:w-48", sm: "w-28 sm:w-32" } as const;

/**
 * A shelf of random images. Opening one steps through the shelf's images
 * (a step list named `name`), not the gallery feed.
 */
export function ImageStrip({
  name,
  items,
  pending,
  filters,
  size = "md",
  placeholders = STRIP_SIZE,
  steps,
}: {
  name: string;
  items: FeedItem[] | undefined;
  pending: boolean;
  /** The filter the strip picked from: the view's way back to a gallery. */
  filters: Filters;
  size?: keyof typeof TILE_WIDTH;
  /** Tiles to hold while loading: as many as are likely to come. */
  placeholders?: number;
  /** What an opened image steps through, when more than the strip shows. */
  steps?: FeedItem[];
}) {
  const tile = cn(TILE, TILE_WIDTH[size]);
  const location = useLocation();
  if (pending || !items) {
    return (
      <div className={SHELF}>
        {Array.from({ length: placeholders }, (_, i) => (
          <Skeleton key={i} className={tile} />
        ))}
      </div>
    );
  }
  const state = { ...withBackgroundLocation(location), ...stepsState({ name, items: steps ?? items }) };
  return (
    <div className={SHELF}>
      {items.map((img) => (
        <Link key={img._id} to={imageHref(img._id, filters)} state={state} className={cn("group", tile)} aria-label={img.path}>
          {img.thumb_url && <ShelfImage src={img.thumb_url} blurhash={img.blurhash} />}
        </Link>
      ))}
    </div>
  );
}
