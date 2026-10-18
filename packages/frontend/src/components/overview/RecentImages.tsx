import { Link, useLocation } from "react-router-dom";
import { ArrowRight, Images } from "lucide-react";
import { Section } from "../ui/Card";
import { cn } from "../../lib/cn";
import { Skeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { useImageFeed } from "../../hooks/useImageFeed";
import { DEFAULT_FILTERS, serializeFilters } from "../../lib/imageFilter";
import { withBackgroundLocation } from "../../lib/backgroundLocation";

// Two full rows at every breakpoint: 12 fill 6 columns; the last 4 only
// show at xl, where the grid is 8 wide.
const SHOWN = 16;
const BASE = 12;
const GRID = "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-2";

/**
 * The newest images across every library. Reads the gallery's own default
 * feed (same filter, same cache), so opening one steps through the rest of
 * the feed in ImageView and the gallery is already loaded when you go there.
 */
export function RecentImages() {
  const location = useLocation();
  const feed = useImageFeed(DEFAULT_FILTERS);
  const items = feed.items.slice(0, SHOWN);
  const qs = serializeFilters(DEFAULT_FILTERS).toString();

  return (
    <Section
      title="Recent"
      actions={
        <Link
          to="/"
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-neutral-100"
        >
          View all <ArrowRight size={14} />
        </Link>
      }
    >
      {feed.isPending ? (
        <div className={GRID}>
          {Array.from({ length: SHOWN }, (_, i) => (
            <Skeleton
              key={i}
              className={cn("aspect-square w-full rounded-lg", i >= BASE && "hidden xl:block")}
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          compact
          icon={Images}
          title="No images yet"
          description="Add a library and its newest images show up here."
        />
      ) : (
        <div className={GRID}>
          {items.map((img, i) => (
            <Link
              key={img._id}
              to={`/image/${encodeURIComponent(img._id)}?${qs}`}
              state={withBackgroundLocation(location)}
              className={cn(
                "block aspect-square overflow-hidden rounded-lg bg-sunken ring-brand-400 focus-visible:outline-none focus-visible:ring-2",
                i >= BASE && "hidden xl:block",
              )}
              title={img.path}
            >
              {img.thumb_url && (
                <img
                  src={img.thumb_url}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover transition-transform duration-200 hover:scale-[1.03]"
                />
              )}
            </Link>
          ))}
        </div>
      )}
    </Section>
  );
}
