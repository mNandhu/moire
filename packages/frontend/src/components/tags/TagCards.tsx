import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Tag as TagIcon, Slash } from "lucide-react";
import { useQueries } from "@tanstack/react-query";
import { Skeleton } from "../ui/Skeleton";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { cn } from "../../lib/cn";
import { smallThumb } from "../../lib/media";
import { useCharacterLookup, type Sample } from "../../lib/queries";
import { formatTag } from "../../lib/tags";
import { galleryTag, type BrowseTag, type TagSource, type TagView } from "../../lib/tagBrowse";
import { tagSamplesQuery } from "../../lib/tagSamples";
import { CARD_ZOOM, displayName, focusPosition, inkOn, type CharacterEntry } from "../../lib/character";
import { Mosaic } from "../TagMosaic";
import { FaceCrop } from "../CharacterAvatar";

/** A tag's description, for its hover label. */
export type Describe = (tag: string) => string | undefined;

// A spine for a character with no colour of its own.
const SPINE_NEUTRAL = "#8a8797";

/** Entries per section before "Show more": grid cards load 3 or 4 images
 * each, list rows one, so the list can afford more. */
const PAGE: Record<TagView, number> = { grid: 60, list: 200 };

export function TagSection({
  title,
  rows,
  view,
  source,
  selected,
  onSelect,
  describe,
}: {
  title: string | null;
  rows: BrowseTag[];
  view: TagView;
  source: TagSource;
  selected: string | null;
  onSelect: (tag: string) => void;
  describe: Describe;
}) {
  const [visible, setVisible] = useState(PAGE[view]);
  // A new filter or view starts the section from its first page again.
  useEffect(() => setVisible(PAGE[view]), [rows, view]);
  const shown = rows.slice(0, visible);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 1);

  return (
    <section aria-label={title ?? "Tags"} className="space-y-3">
      {title && (
        <h2 className="text-sm font-semibold text-muted">
          {title} <span className="text-faint font-normal tabular-nums">{rows.length.toLocaleString()}</span>
        </h2>
      )}
      {view === "grid" ? (
        <TagGrid rows={shown} source={source} selected={selected} onSelect={onSelect} describe={describe} />
      ) : (
        <div className="rounded-xl border border-white/5 bg-surface shadow-panel overflow-hidden divide-y divide-white/5">
          {shown.map((t) => (
            <Described key={t.tag} text={describe(t.tag)}>
              <TagRow tag={t} max={max} active={t.tag === selected} onSelect={onSelect} />
            </Described>
          ))}
        </div>
      )}
      {rows.length > visible && (
        <div className="flex justify-center">
          <Button onClick={() => setVisible((v) => v + PAGE[view])}>
            Show more ({(rows.length - visible).toLocaleString()} left)
          </Button>
        </div>
      )}
    </section>
  );
}

/** Mosaic cards; samples are fetched in one batch for the cards on screen. */
function TagGrid({
  rows,
  source,
  selected,
  onSelect,
  describe,
}: {
  rows: BrowseTag[];
  source: TagSource;
  selected: string | null;
  onSelect: (tag: string) => void;
  describe: Describe;
}) {
  const characters = useCharacterLookup();
  // One request for the cards that asked in the same render; a changed list
  // (a pinned cover, a rename) invalidates TAG_SAMPLES_KEY and the mosaics refresh.
  const ids = useMemo(
    () => rows.filter((t) => t.category !== "character").map((t) => galleryTag(t.tag, source)),
    [rows, source],
  );
  const results = useQueries({ queries: ids.map((id) => tagSamplesQuery(id, 4, 60_000)) });
  const samples = new Map(ids.map((id, i) => [id, results[i].data] as const));

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(170px,calc(50%_-_6px)),1fr))] gap-3">
      {rows.map((t) =>
        t.category === "character" ? (
          <SpineCard
            key={t.tag}
            tag={t}
            character={characters.get(t.tag)}
            selected={t.tag === selected}
            onSelect={onSelect}
          />
        ) : (
          <Described key={t.tag} text={describe(t.tag)}>
            <NumeralCard
              tag={t}
              samples={samples.get(galleryTag(t.tag, source))}
              selected={t.tag === selected}
              onSelect={onSelect}
            />
          </Described>
        ),
      )}
    </div>
  );
}

const CARD =
  "group relative block overflow-hidden border bg-surface shadow-panel text-left card-hover focus-visible:outline-none";
const cardState = (on: boolean) =>
  on ? "border-brand-400 ring-1 ring-brand-400" : "border-white/5";

/**
 * A character as a manga volume on a shelf: their name runs up a spine in
 * their own colour, beside a portrait cropped to their upper body.
 */
function SpineCard({
  tag: t,
  character: c,
  selected,
  onSelect,
}: {
  tag: BrowseTag;
  character: CharacterEntry | undefined;
  selected: boolean;
  onSelect: (tag: string) => void;
}) {
  const colour = c?.color ?? SPINE_NEUTRAL;
  const { name } = displayName(c ?? { tag: t.tag });
  return (
    <button
      type="button"
      onClick={() => onSelect(t.tag)}
      aria-pressed={selected}
      aria-label={`${formatTag(t.tag)}: ${t.count.toLocaleString()} images`}
      className={cn(CARD, "flex", cardState(selected))}
    >
      {/* The spine takes the portrait's height and never sets it: in flow, a
          long name grew the card taller than 3:4 and stretched the portrait,
          whose crop is worked out for exactly 3:4. */}
      <span className="relative w-8 shrink-0" style={{ background: colour }}>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-between gap-2 py-2.5 [writing-mode:vertical-rl] rotate-180",
            "text-xs font-bold uppercase tracking-[0.08em]",
            inkOn(colour) === "dark" ? "text-canvas" : "text-white",
          )}
        >
          <span className="truncate min-h-0">{name}</span>
          <span className="shrink-0 font-mono font-medium text-2xs tracking-normal opacity-75 tabular-nums">
            {t.count.toLocaleString()}
          </span>
        </span>
      </span>
      <FaceCrop
        src={c?.thumb_url ?? t.thumb_url}
        face={c?.face ?? null}
        focus={c?.focus ?? null}
        aspect={c?.aspect ?? null}
        frame={3 / 4}
        zoom={CARD_ZOOM}
        className="flex-1 aspect-[3/4] text-5xl"
        letter={name}
      />
    </button>
  );
}

/** A tag as a collage of its images, its image count a large faint numeral. */
function NumeralCard({
  tag: t,
  samples,
  selected,
  onSelect,
}: {
  tag: BrowseTag;
  samples: Sample[] | undefined;
  selected: boolean;
  onSelect: (tag: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(t.tag)}
      aria-pressed={selected}
      className={cn(CARD, "bg-sheen w-full", cardState(selected))}
    >
      <Mosaic samples={samples} cover={t.thumb_url} focus={t.focus} focusImage={t.thumb_image_id} className="aspect-[3/4]" smallCells />
      <div className="relative overflow-hidden px-3 pt-2.5 pb-3">
        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-3.5 text-[3.25rem] font-extrabold leading-none tracking-tighter tabular-nums text-white/[0.07]"
        >
          {t.count.toLocaleString()}
        </span>
        <div className="relative text-[15px] font-bold truncate">{formatTag(t.tag)}</div>
        <div className="relative mt-0.5 text-2xs uppercase tracking-[0.08em] text-faint">
          {t.count.toLocaleString()} {t.count === 1 ? "image" : "images"}
        </div>
      </div>
    </button>
  );
}

function TagRow({
  tag,
  max,
  active,
  onSelect,
}: {
  tag: BrowseTag;
  max: number;
  active: boolean;
  onSelect: (tag: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tag.tag)}
      aria-pressed={active}
      className={cn(
        "w-full grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(4rem,10rem)_3.5rem] items-center gap-3 px-3 py-1.5 text-left hover:bg-raised",
        active && "bg-brand-600/15",
      )}
    >
      <span className="h-10 w-10 rounded-md overflow-hidden bg-raised">
        {tag.thumb_url && (
          <img
            src={smallThumb(tag.thumb_url)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            style={{ objectPosition: focusPosition(tag.focus ?? null) }}
          />
        )}
      </span>
      <span className="text-sm font-medium truncate">{formatTag(tag.tag)}</span>
      <span className="h-1.5 rounded-full bg-line overflow-hidden" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-brand-400/80"
          style={{ width: `${Math.max(2, (tag.count / max) * 100)}%` }}
        />
      </span>
      <span className="text-sm text-muted tabular-nums text-right">{tag.count.toLocaleString()}</span>
    </button>
  );
}

/** A hover label with the tag's description, around a card or row. Always
 * the same wrapper, so descriptions arriving late don't remount the cards. */
function Described({ text, children }: { text: string | undefined; children: ReactNode }) {
  return (
    <Tooltip content={text} bubble className="flex min-w-0">
      {children}
    </Tooltip>
  );
}

export function LoadingGrid({ view }: { view: TagView }) {
  if (view === "list") {
    return (
      <div className="space-y-1">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(170px,calc(50%_-_6px)),1fr))] gap-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="overflow-hidden border border-white/5 bg-surface shadow-panel">
          <Skeleton className="w-full aspect-[3/4] rounded-none" />
          <div className="p-3 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SpecialTile({
  title,
  subtitle,
  to,
  icon,
}: {
  title: string;
  subtitle: string;
  to: string;
  /** Defaults to a struck-out tag: something missing. */
  icon?: ReactNode;
}) {
  return (
    <Link
      to={to}
      title={title}
      className="rounded-xl border border-white/5 bg-surface bg-sheen shadow-panel px-4 py-3 text-left card-hover min-w-0 sm:min-w-[180px]"
    >
      <div className="flex items-center gap-2 font-semibold">
        <span className="relative inline-flex items-center justify-center w-5 h-5">
          {icon ?? (
            <>
              <TagIcon size={16} />
              <Slash size={16} className="absolute inset-0 text-brand-300" />
            </>
          )}
        </span>
        {title}
      </div>
      <div className="text-xs text-muted mt-0.5">{subtitle}</div>
    </Link>
  );
}
