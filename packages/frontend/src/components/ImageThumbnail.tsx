import { cn } from "../lib/cn";
import { LOAD_AHEAD_PX } from "../lib/masonryLayout";
import { useImageLoadSlot } from "../hooks/useImageLoadSlot";
import { decode } from "blurhash";
import React, { useEffect, useRef } from "react";

// Decodes a BlurHash to a canvas, scaled up by CSS to fill the tile. A hash
// only holds a few low-frequency components, so 32px upscaled with smoothing
// looks the same as 64px at a quarter of the decode cost (BlurHash decode is
// O(px * comps)), which every virtualized tile pays again on each mount.
const BLUR_PX = 32;

const BlurhashCanvas = React.memo(function BlurhashCanvas({
  hash,
  loaded,
}: {
  hash: string;
  loaded: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      const pixels = decode(hash, BLUR_PX, BLUR_PX);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const imageData = ctx.createImageData(BLUR_PX, BLUR_PX);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);
    } catch {
      // Invalid hash: leave the canvas transparent; the bg shows through.
    }
  }, [hash]);
  return (
    <canvas
      ref={ref}
      width={BLUR_PX}
      height={BLUR_PX}
      aria-hidden="true"
      className={cn(
        "absolute inset-0 h-full w-full rounded-xl transition-opacity duration-500 ease-out",
        loaded ? "opacity-0" : "opacity-100"
      )}
    />
  );
});

export function ImageThumbnail({
  src,
  selected,
  dimmed = false,
  onClick,
  alt,
  width,
  height,
  priority = false,
  blurhash,
  getRoot,
  eager = false,
}: {
  src: string;
  selected?: boolean;
  /** Held back visually (quarantined), still readable, clearly set aside. */
  dimmed?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  alt?: string;
  width?: number;
  height?: number;
  priority?: boolean; // High priority for above-the-fold images
  blurhash?: string | null; // BlurHash placeholder shown until the image loads
  // Scroll container to use as the IntersectionObserver root. Must be the actual
  // scrolling element: rootMargin only expands the root, while intermediate
  // scroll containers clip at zero margin, killing the preload window.
  getRoot?: () => HTMLElement | null;
  // Skip the per-tile IntersectionObserver and load as soon as mounted. The
  // grid already gates mounting to a near-viewport overscan window, so a second
  // IO gate is redundant work per tile. Left as a prop rather than assumed so a
  // future non-virtualized caller can still opt into observer-gated loading.
  eager?: boolean;
}) {
  const { assignedSrc, loaded, error, imgRef, onLoad, onError } =
    useImageLoadSlot({
      src,
      priority,
      eager,
      getRoot,
      // Start loading ~1.5 screens early so thumbs are decoded by the time they
      // scroll into view. Shares one constant with the virtualized grid's
      // overscan, which must stay wider than this.
      rootMargin: `${LOAD_AHEAD_PX}px 0px`,
    });

  return (
    <button
      className={cn(
        "group relative block w-full overflow-hidden rounded-xl bg-neutral-900",
        "transition-shadow duration-150 ease-out",
        "hover:shadow-[0_8px_30px_-12px_rgba(0,0,0,0.9)]",
        selected && "ring-2 ring-brand-500"
      )}
      onClick={onClick}
    >
      {/* Placeholder: a decoded BlurHash preview when we have one (no grey
          "loading" state), else a shimmer skeleton. The BlurHash stays mounted
          across load so it can cross-fade out as the image fades in, instead of
          popping. */}
      {!error && blurhash && <BlurhashCanvas hash={blurhash} loaded={loaded} />}
      {!loaded && !error && !blurhash && (
        <div
          className={cn(
            "absolute inset-0 rounded-xl bg-neutral-800/60 animate-pulse",
            "motion-reduce:animate-none"
          )}
          aria-hidden="true"
        />
      )}

      {/* Error state */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-800 text-faint">
          <span className="text-sm">Failed to load</span>
        </div>
      )}

      <img
        ref={imgRef}
        src={assignedSrc ?? undefined}
        alt={alt}
        decoding="async"
        // React 18 only knows the lowercase DOM attribute; the camelCase
        // prop warns on every tile. (React 19 accepts fetchPriority.)
        {...{ fetchpriority: priority ? "high" : "low" }}
        width={width}
        height={height}
        onLoad={onLoad}
        onError={onError}
        className={cn(
          "h-auto w-full object-cover ease-out",
          // Two animations with different jobs, so two durations. The load-in
          // fade is slow (500ms, matching the BlurHash cross-fade, so they
          // dissolve together); the hover zoom is fast (150ms), because it
          // answers a pointer and anything near the fade's duration reads as
          // lag. They shared one `transition-[opacity,transform] duration-500`
          // before, which made every hover feel like the UI was thinking.
          "[transition-property:transform,opacity]",
          "[transition-duration:150ms,500ms]",
          "motion-safe:group-hover:scale-[1.03]",
          "motion-reduce:transition-none",
          // One opacity decision, not two competing classes: an unloaded image
          // stays fully transparent whether or not it is dimmed.
          !loaded || error ? "opacity-0" : dimmed ? "opacity-45" : "opacity-100",
          dimmed && "saturate-50"
        )}
        // No `loading="lazy"`: when to load is decided above (the grid mounts
        // only near the viewport, then a slot from the shared queue). The
        // browser's own lazy gate held slotted tiles just off screen unfetched
        // until a scroll, and with every slot held so, the visible tiles
        // queued behind them sat on their BlurHash.
      />
      {/* Hover treatment lifts rather than dims. The old overlay was a
          `bg-black/10` veil, which darkened whichever image you pointed at:
          exactly backwards for a gallery, where hover should mean "this one". */}
      <div
        className={cn(
          "pointer-events-none absolute inset-0 rounded-xl",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-150",
          "ring-1 ring-inset ring-white/20",
          "bg-gradient-to-t from-white/0 via-white/0 to-white/10",
          "motion-reduce:transition-none"
        )}
      />
    </button>
  );
}
