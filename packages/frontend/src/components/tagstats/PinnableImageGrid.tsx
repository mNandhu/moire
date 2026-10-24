import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { PendingVeil, PinButton } from "../PinButton";
import { useImageFeed } from "../../hooks/useImageFeed";
import { useOpenImage } from "../../hooks/useOpenImage";
import { usePinCover } from "../../hooks/usePinCover";
import type { Filters } from "../../lib/imageFilter";

// The side panel's strip is a narrow 3-wide grid; the page's is wider.
const LOOKS = {
  panel: {
    Heading: "h3",
    grid: "grid grid-cols-3 gap-1",
    skeletons: 9,
    more: "mt-1",
  },
  page: {
    Heading: "h2",
    grid: "grid grid-cols-3 sm:grid-cols-4 xl:grid-cols-6 gap-1.5",
    skeletons: 12,
    more: "mt-2",
  },
} as const;

/**
 * A tag's or character's own images, newest first. Clicking one opens it in
 * the viewer over the current page, paging through these images; the pin on
 * hover makes it the cover (a person's avatar) of `pinTag`.
 */
export function PinnableImageGrid({
  filters,
  pinTag,
  pinned,
  noun,
  count,
  pageSize,
  variant,
}: {
  filters: Filters;
  /** The tag whose cover the pin sets. */
  pinTag: string;
  pinned: string | null;
  noun: "avatar" | "cover";
  count: number;
  pageSize: number;
  variant: keyof typeof LOOKS;
}) {
  const look = LOOKS[variant];
  const { pin, pending } = usePinCover(noun);
  const open = useOpenImage(filters);
  const { items, hasNextPage, fetchNextPage, isFetchingNextPage, isLoading } = useImageFeed(filters, pageSize);

  return (
    <section>
      <look.Heading className="text-2xs uppercase tracking-wider text-faint mb-2">
        Images · {count.toLocaleString()}
      </look.Heading>
      <div className={look.grid}>
        {isLoading &&
          Array.from({ length: look.skeletons }).map((_, i) => <Skeleton key={i} className="aspect-square rounded" />)}
        {items.map((img) => {
          const on = img._id === pinned;
          return (
            <div key={img._id} className="group/img relative aspect-square rounded overflow-hidden bg-raised">
              <button
                type="button"
                onClick={() => open(img._id)}
                aria-label={`Open ${img.path}`}
                title={img.path}
                className="absolute inset-0 hover:opacity-90"
              >
                <img src={img.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />
              </button>
              {/* A sibling of the open button, not inside it. */}
              {pending === img._id && <PendingVeil />}
              <PinButton
                on={on}
                pending={pending === img._id}
                disabled={pending !== null}
                noun={noun}
                onClick={() => void pin(pinTag, img._id, { unpin: on })}
              />
            </div>
          );
        })}
      </div>
      {hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className={look.more}
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? "Loading…" : "More images"}
        </Button>
      )}
    </section>
  );
}
