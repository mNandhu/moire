import { cn } from "../lib/cn";
import { avatarCrop, focusPosition, FACE_ZOOM, type Face } from "../lib/character";

type FaceCropProps = {
  src: string | null | undefined;
  face: Face | null;
  focus: readonly [number, number] | null;
  aspect: number | null;
  className?: string;
  style?: React.CSSProperties;
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
}: FaceCropProps & { frame?: number; zoom?: number }) {
  const crop = avatarCrop({ face, focus, aspect }, frame, zoom);
  return (
    <div className={cn("relative shrink-0 overflow-hidden bg-raised", className)} style={style}>
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          className={crop ? "absolute max-w-none" : "h-full w-full object-cover"}
          style={crop ?? { objectPosition: focusPosition(focus) }}
        />
      )}
    </div>
  );
}

/** A character's round avatar, cropped to the face. */
export function CharacterAvatar({ className, ...rest }: FaceCropProps) {
  return <FaceCrop {...rest} className={cn("rounded-full", className)} />;
}
