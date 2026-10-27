import React, { useEffect, useState } from "react";
import { Check, Layers, ShieldOff, Sparkles } from "lucide-react";
import { ImageThumbnail } from "./ImageThumbnail";
import { cn } from "../lib/cn";
import { ratingDotClass } from "../lib/rating";
import { ScoreMark } from "./ui/ScoreMark";
import { useBatchScrub } from "../hooks/useBatchScrub";
import { useCrossfade } from "../hooks/useCrossfade";
import type { ImageDoc } from "../lib/imageFilter";

type ImageDocWithDims = ImageDoc & { width?: number; height?: number };

/**
 * One gallery tile: the thumbnail plus every piece of triage state the user
 * needs to see without opening the image.
 *
 * The gallery is where scoring, quarantining and tagging actually happen, so a
 * tile that renders only the picture makes the work invisible. You score an
 * image, nothing changes on screen, and you can't tell what you've already
 * been through when you come back. The overlays here are that feedback:
 * score pips, an untagged marker, a rating dot, quarantine state.
 *
 * Overlay visibility follows one rule: **state that is set is always visible;
 * affordances appear on hover.** A scored image shows its score at rest; an
 * unscored one shows nothing until you point at it. That keeps a wall of
 * already-triaged images readable while leaving the untouched ones clean.
 *
 * The selection checkbox is not one of those overlays. It exists only in
 * selection mode. A picking affordance sitting on every tile is visual noise
 * on a screen whose entire job is looking at pictures, so entering the mode is
 * the deliberate opt-in that puts it there.
 */
export const ThumbnailTile = React.memo(function ThumbnailTile({
  item,
  index,
  selected,
  selectionMode,
  onToggle,
  onOpen,
  getRoot,
  eager = false,
  focused = false,
  dimQuarantined = true,
  peekQuery = "",
}: {
  item: ImageDocWithDims;
  index: number;
  selected: boolean;
  /** Selection mode is on: the checkbox is shown and clicks pick rather than open. */
  selectionMode: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  getRoot?: () => HTMLElement | null;
  eager?: boolean;
  focused?: boolean;
  /** Hold a quarantined tile back visually. Off in the quarantined view, where
   * every tile is quarantined and the badge alone carries the meaning. */
  dimQuarantined?: boolean;
  /** Active gallery filters, serialized for the batch-peek fetch; see
   * serializeFiltersForPeek. Scopes the peek to the same members the grouped
   * feed considered when it picked this tile as the representative. */
  peekQuery?: string;
}) {
  // The versioned URL the feed carries (no per-tile resolve request).
  const src = item.thumb_url ?? "";

  const groupCount = item.group_count ?? 1;
  const isBatch = groupCount > 1;
  const [scrubbing, setScrubbing] = useState(false);
  // Entering selection mode detaches the mouse handlers below (a picking
  // affordance shouldn't also be scrubbing), which means the onMouseLeave
  // that would normally clear `scrubbing` never fires if selection mode
  // engages mid-hover. Without this, the flag stays stuck true and the tile
  // starts peeking on its own, with the pointer nowhere near it, the moment
  // selection mode turns back off.
  useEffect(() => {
    if (selectionMode) setScrubbing(false);
  }, [selectionMode]);
  const scrub = useBatchScrub(
    item.group_id,
    isBatch && scrubbing && !selectionMode,
    peekQuery,
  );

  // Cross-fades the peeked members over the representative.
  const { layers: scrubLayers, front: scrubFront } = useCrossfade(scrub.src);

  const score = item.score ?? 0;
  const hasScore = score > 0;
  const quarantined = !!item.quarantined;
  // has_ai_tags is only meaningful when the feed actually sent it; an older
  // payload without the field must not paint every tile as untagged.
  const untagged = item.has_ai_tags === false;
  const ratingDot = ratingDotClass(item.rating);

  const chipVisibility = (always: boolean) =>
    always
      ? "opacity-100"
      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div
      className={cn(
        "relative group h-full rounded-xl shadow-tile transition-shadow duration-150",
        focused && "ring-2 ring-brand-400 ring-offset-2 ring-offset-canvas",
        selected && "ring-2 ring-brand-500",
      )}
      data-tile-index={index}
      tabIndex={-1}
      onMouseEnter={isBatch && !selectionMode ? () => setScrubbing(true) : undefined}
      onMouseLeave={isBatch && !selectionMode ? () => setScrubbing(false) : undefined}
    >
      <ImageThumbnail
        src={src}
        blurhash={item.blurhash}
        alt={item.path}
        width={item.width}
        height={item.height}
        selected={selected}
        dimmed={quarantined && dimQuarantined}
        onClick={() => (selectionMode ? onToggle(item._id) : onOpen(item._id))}
        priority={index < 12} // First 12 items get high priority
        getRoot={getRoot}
        eager={eager}
      />

      {/* Batch peek: while the pointer rests on a collapsed batch, its other
          members cross-fade over the representative. Layered on top rather than
          swapped into ImageThumbnail's src so the tile's own load state, and
          the BlurHash it already resolved, are left alone. Two layers alternate
          front/back so every step dissolves, including the wrap back to the
          first frame; see useCrossfade. */}
      {scrubLayers.map((layerSrc, i) =>
        layerSrc ? (
          <img
            key={i}
            src={layerSrc}
            alt=""
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 h-full w-full rounded-xl object-cover",
              "motion-safe:transition-opacity motion-safe:duration-300 motion-safe:ease-in-out",
              scrubFront === i ? "opacity-100" : "opacity-0",
            )}
          />
        ) : null,
      )}

      {/* Selection checkbox: only in selection mode. */}
      {selectionMode && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item._id);
          }}
          aria-label={selected ? "Deselect" : "Select"}
          aria-pressed={selected}
          className={cn(
            "absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center",
            "border transition-[background-color,border-color] duration-150",
            selected
              ? "bg-brand-500 border-brand-300 text-white"
              : "bg-black/50 border-white/50 text-transparent hover:bg-black/70 backdrop-blur-sm",
          )}
        >
          <Check size={14} strokeWidth={3} />
        </button>
      )}

      {/* Batch-stack indicator: this tile represents N grouped variations. */}
      {isBatch && !selectionMode && (
        <span
          className={cn(
            "absolute top-2 left-2 px-1.5 py-0.5 rounded-md text-2xs font-medium",
            "bg-black/70 border border-white/15 text-white pointer-events-none",
            "inline-flex items-center gap-1 backdrop-blur-sm",
            scrubbing && "bg-brand-600/80 border-brand-300/40",
          )}
          title={`${groupCount} variations in this batch`}
        >
          <Layers size={11} />{" "}
          {/* Denominator is the batch size, not scrub.total; the peek only
              fetches the first MAX_MEMBERS, so showing its length turned a
              40-image batch into "3/12" the moment you hovered it. */}
          {scrub.total > 1 && scrubbing
            ? `${scrub.position + 1}/${groupCount}`
            : groupCount}
        </span>
      )}

      {/* Triage state, bottom edge. The scrim keeps it legible over a bright
          thumbnail without dimming the image itself. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 px-2 pb-1.5 pt-6 rounded-b-xl",
          "flex items-end justify-between gap-2",
          "bg-gradient-to-t from-black/75 via-black/35 to-transparent",
          "transition-opacity duration-150",
          // `untagged` is deliberately not here: in a mostly untagged library
          // the marker sat on every tile and read as noise, so it shows on
          // hover only. Finding untagged images is the "Show only: Untagged"
          // filter's job.
          chipVisibility(hasScore || quarantined || !!ratingDot),
        )}
      >
        {/* No score, no bar: blank pips aren't state. The empty span keeps
            the markers on the right. */}
        {hasScore ? <ScoreMark score={score} /> : <span />}
        <div className="flex items-center gap-1.5">
          {untagged && (
            <span
              className={cn("text-white/70", chipVisibility(false))}
              title="No AI tags yet"
              aria-label="Untagged"
            >
              <Sparkles size={13} />
            </span>
          )}
          {ratingDot && (
            <span
              className={cn("h-2 w-2 rounded-full", ratingDot)}
              title={`Rating: ${item.rating}`}
            />
          )}
          {quarantined && (
            <span className="text-red-300" title="Quarantined">
              <ShieldOff size={13} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
