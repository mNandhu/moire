import { Link, useLocation } from "react-router-dom";
import { ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { withBackgroundLocation } from "@/lib/backgroundLocation";
import { stepsState } from "@/lib/stepList";
import { imageHref, type FeedItem, type Filters } from "@/features/images/lib/imageFilter";
import { STRIP_SIZE } from "@/features/discover/lib/queries";

// Two rows at every breakpoint; the last four only show at xl.
const BASE = 8;
const DISCOVER_GRID = "grid grid-cols-4 xl:grid-cols-6 gap-2";

/** A Discover section: its title, a new pick and a way to see all of it. */
export function DiscoverSection({
  label,
  title = label,
  onDeal,
  viewAll,
  children,
}: {
  /** The section's name (its region's, and the title unless one is given). */
  label: string;
  title?: React.ReactNode;
  onDeal: () => void;
  /** Where "View all" goes. */
  viewAll: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label}>
    <Section
      title={title}
      actions={
        <div className="flex items-center gap-1">
          <Tooltip content="Pick again" bubble>
            <Button size="iconSm" variant="ghost" onClick={onDeal} aria-label={`Pick again: ${label}`}>
              <RefreshCw size={14} />
            </Button>
          </Tooltip>
          <Link
            to={viewAll}
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-neutral-100"
          >
            View all <ArrowRight size={14} />
          </Link>
        </div>
      }
    >
      {children}
    </Section>
    </section>
  );
}

/**
 * A strip of random images. Opening one steps through the strip's images
 * (a step list named `name`), not the gallery feed.
 */
export function ImageStrip({
  name,
  items,
  pending,
  filters,
}: {
  name: string;
  items: FeedItem[] | undefined;
  pending: boolean;
  /** The filter the strip picked from: the view's way back to a gallery. */
  filters: Filters;
}) {
  const location = useLocation();
  if (pending || !items) {
    return (
      <div className={DISCOVER_GRID}>
        {Array.from({ length: STRIP_SIZE }, (_, i) => (
          <Skeleton key={i} className={cn("aspect-square w-full rounded-lg", i >= BASE && "hidden xl:block")} />
        ))}
      </div>
    );
  }
  const state = { ...withBackgroundLocation(location), ...stepsState({ name, items }) };
  return (
    <div className={DISCOVER_GRID}>
      {items.map((img, i) => (
        <Link
          key={img._id}
          to={imageHref(img._id, filters)}
          state={state}
          className={cn(
            "block aspect-square overflow-hidden rounded-lg bg-sunken ring-brand-400 focus-visible:outline-none focus-visible:ring-2",
            i >= BASE && "hidden xl:block",
          )}
          aria-label={img.path}
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
  );
}
