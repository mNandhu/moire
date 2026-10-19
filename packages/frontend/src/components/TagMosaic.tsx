import { Tag as TagIcon } from "lucide-react";
import { Skeleton } from "./ui/Skeleton";
import { cn } from "../lib/cn";

/** One `/tags/samples` image. */
export type Sample = { _id: string; thumb_url: string };

/** 2x2 collage of distinct images. Adapts to 1–4 samples; cells crop to
 * keep a tidy square (it reads as a deliberate collage, not a thumbnail).
 * Shows the cover alone until the samples arrive. */
export function Mosaic({
  samples,
  cover,
  className = "aspect-square",
}: {
  samples: Sample[] | undefined;
  cover: string | null;
  /** Its shape; a square by default. */
  className?: string;
}) {
  if (samples === undefined) {
    return cover ? (
      <div className={cn("relative w-full bg-raised", className)}>
        <img src={cover} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      </div>
    ) : (
      <Skeleton className={cn("w-full rounded-none", className)} />
    );
  }
  if (samples.length === 0) {
    return (
      <div className={cn("w-full bg-raised flex items-center justify-center text-faint", className)}>
        <TagIcon size={28} />
      </div>
    );
  }

  const cells = samples.slice(0, 4);
  // Layout per count: 1 = full, 2 = halves, 3 = big + 2, 4 = 2x2.
  const spanClass = (i: number) => {
    if (cells.length === 1) return "col-span-2 row-span-2";
    if (cells.length === 2) return "row-span-2";
    if (cells.length === 3 && i === 0) return "row-span-2";
    return "";
  };

  return (
    <div className={cn("grid grid-cols-2 grid-rows-2 gap-px bg-raised", className)}>
      {cells.map((s, i) => (
        <div key={s._id} className={cn("relative overflow-hidden bg-neutral-900", spanClass(i))}>
          <img
            src={s.thumb_url}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        </div>
      ))}
    </div>
  );
}
