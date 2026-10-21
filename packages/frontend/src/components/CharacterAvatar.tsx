import { useState } from "react";
import { cn } from "../lib/cn";
import { Skeleton } from "./ui/Skeleton";
import { avatarCrop, focusPosition, FACE_ZOOM, type Face } from "../lib/character";

type FaceCropProps = {
  src: string | null | undefined;
  face: Face | null;
  focus: readonly [number, number] | null;
  aspect: number | null;
  className?: string;
  style?: React.CSSProperties;
  /** Shown when there is no image yet (a character made by hand). */
  letter?: string;
};

/**
 * A character's image cropped to their face (see `avatarCrop`) in a frame
 * of shape `frame` (width / height), framed by the user's focus point when
 * set. Sized by the caller's `className`, which must give it that shape.
 */
export function FaceCrop({
  src,
  face,
  focus,
  aspect,
  frame = 1,
  zoom = FACE_ZOOM,
  className,
  style,
  letter,
}: FaceCropProps & { frame?: number; zoom?: number }) {
  const crop = avatarCrop({ face, focus, aspect }, frame, zoom);
  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-raised", className)} style={style}>
      {!src && letter && (
        <span className="absolute inset-0 grid place-items-center font-semibold uppercase text-muted">
          {letter.slice(0, 1)}
        </span>
      )}
      {src && (
        <FadeIn
          // A new image starts unloaded again.
          key={src}
          src={src}
          className={crop ? "absolute max-w-none" : "h-full w-full object-cover"}
          style={crop ?? { objectPosition: focusPosition(focus) }}
        />
      )}
    </div>
  );
}

/** Shimmers until the image arrives, then fades it in. */
function FadeIn({ src, className, style }: { src: string; className: string; style: React.CSSProperties }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={cn(className, "transition-opacity duration-200", loaded ? "opacity-100" : "opacity-0")}
        style={style}
      />
    </>
  );
}

/** A character's round avatar, cropped to the face. */
export function CharacterAvatar({ className, ...rest }: FaceCropProps) {
  return <FaceCrop {...rest} className={cn("rounded-full", className)} />;
}
