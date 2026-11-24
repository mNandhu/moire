import { useLayoutEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { avatarCrop } from "@/features/characters/lib/character";
import { FaceCrop } from "@/features/characters/components/CharacterAvatar";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { bannerFade, faceLanding, type BannerPicture } from "@/features/discover/lib/discover";

// A phone's image spans the banner under the text: its face, mid-frame,
// stays clear.
const EDGE_PHONE =
  "linear-gradient(to right, transparent, rgb(0 0 0 / 0.3) 15%, rgb(0 0 0 / 0.75) 32%, black 45%)";
const BOTTOM = "linear-gradient(to bottom, black 55%, rgb(0 0 0 / 0.6) 72%, rgb(0 0 0 / 0.2) 87%, transparent)";

// The face's box grown this many times fills the banner's height: the head
// and shoulders, not the face alone.
const BANNER_ZOOM = 6;

/** A mask fading the frame in from the left and, over a shelf, out at the bottom. */
function fade(edge: string, bottom: boolean): React.CSSProperties {
  const mask = bottom ? `${edge}, ${BOTTOM}` : edge;
  return {
    maskImage: mask,
    WebkitMaskImage: mask,
    // Both fades at once (the standard value; the -webkit- one, "source-in",
    // overrode it in Chrome and left the top of the image opaque).
    maskComposite: "intersect",
  };
}

/** The frame's width / height, as it is laid out (1 until measured). */
function useFrameShape(mounted: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [shape, setShape] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientHeight) setShape(el.clientWidth / el.clientHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // The frame comes and goes with the picture: observe the one there is.
  }, [mounted]);
  return [ref, shape] as const;
}

/**
 * A lit banner: a picture framed on the right (on its face when one is
 * known, else the image whole in a squarer frame), lit by a blurred copy of
 * itself and an optional colour, with its text and actions on the left and
 * an optional shelf along the bottom. Discover's character and Overview's
 * latest session both use it.
 */
export function Banner({
  label,
  picture,
  glowSrc,
  color,
  text,
  actions,
  children,
}: {
  /** The region's name. */
  label: string;
  /** What the banner shows (see `bannerPicture`); undefined while it's
   * chosen, null for none (the light and text alone). */
  picture: BannerPicture | null | undefined;
  /** An image whose colours light the box while the picture is chosen. */
  glowSrc?: string | null;
  /** A colour cast from the lower left. */
  color?: string | null;
  /** The heading block; undefined shows placeholders. */
  text: React.ReactNode | undefined;
  actions?: React.ReactNode;
  /** Under the banner, on its light: a shelf. */
  children?: React.ReactNode;
}) {
  const [frameRef, shape] = useFrameShape(picture !== null);
  const wide = useMediaQuery("(min-width: 640px)");
  const at: [number, number] = wide ? [0.7, 0.42] : [0.5, 0.4];
  // Where the face really lands (a narrow image can't put it as far right
  // as asked): the fade ends just before it.
  const edge =
    wide && picture
      ? bannerFade(faceLanding(avatarCrop(picture, shape, BANNER_ZOOM, at), picture))
      : EDGE_PHONE;
  // Nothing to centre on (no face found, no point set): the image runs the
  // whole box's height in a squarer frame (its upper part, where a face
  // usually is), not a thin slice blown up to the banner's width.
  const whole = wide && !!picture && !picture.face && !picture.focus && (picture.aspect ?? 1) < 1.3;
  const glow = picture?.src ?? glowSrc;
  return (
    <div
      className="relative isolate overflow-hidden rounded-2xl border border-white/5 bg-sunken shadow-panel"
      aria-label={label}
      role="region"
    >
      {/* The picture's colours at once, while it is chosen. */}
      {glow && (
        <img
          src={glow}
          alt=""
          aria-hidden
          className="absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-45 blur-2xl saturate-150"
        />
      )}
      {color && (
        <div
          className="absolute inset-0 -z-10 opacity-40"
          style={{ background: `radial-gradient(120% 90% at 20% 100%, ${color}, transparent 70%)` }}
        />
      )}
      {/* Shade for the text, down the whole box so the shelf sits in it too. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-canvas/90 via-canvas/40 to-transparent sm:via-canvas/20" />
      {/* A phone's text sits over the image: shade it from below, the shelf too. */}
      <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-canvas/90 via-canvas/45 to-transparent sm:hidden" />
      {picture !== null && (
      <div
        ref={frameRef}
        className={cn(
          "absolute right-0 top-0",
          whole ? "bottom-0 aspect-[11/10] max-w-[70%]" : "h-72 w-full sm:h-80 sm:w-[70%]",
        )}
        // A whole-box image ends at the box's bottom: no fade there.
        style={fade(edge, !!children && !whole)}
      >
        {picture ? (
          <FaceCrop
            src={picture.src}
            face={picture.face}
            focus={picture.focus}
            aspect={picture.aspect}
            frame={shape}
            zoom={BANNER_ZOOM}
            at={at}
            className="h-full w-full bg-transparent"
          />
        ) : (
          // Choosing the picture: a shimmer over the glow's colours; with
          // nothing to glow yet, a plain placeholder.
          <Skeleton className={cn("h-full w-full rounded-none", glow && "bg-transparent")} />
        )}
      </div>
      )}
      <div className="relative h-72 sm:h-80">
        <div className="relative z-[2] flex h-full max-w-lg flex-col justify-end gap-4 p-6 sm:p-8">
          {text ?? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-64" />
            </div>
          )}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
      {children && <div className="relative z-[2] -mt-3 px-6 pb-6 sm:px-8 sm:pb-7">{children}</div>}
    </div>
  );
}
