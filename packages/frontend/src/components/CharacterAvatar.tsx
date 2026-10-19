import { cn } from "../lib/cn";
import { avatarCrop, focusPosition, type Face } from "../lib/character";

/**
 * A character's round avatar: their cover image cropped to the face when
 * one was found (see `avatarCrop`), else framed by the user's focus point.
 * Sized and ringed by the caller's `className`.
 */
export function CharacterAvatar({
  src,
  face,
  focus,
  aspect,
  className,
  style,
}: {
  src: string | null | undefined;
  face: Face | null;
  focus: readonly [number, number] | null;
  aspect: number | null;
  className?: string;
  style?: React.CSSProperties;
}) {
  const crop = avatarCrop({ face, focus, aspect });
  return (
    <div className={cn("relative shrink-0 overflow-hidden rounded-full bg-raised", className)} style={style}>
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
