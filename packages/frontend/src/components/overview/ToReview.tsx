import { Link } from "react-router-dom";
import { ChevronRight, ShieldOff, Sparkles, Tag } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Section } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { useAiCoverage, useImageStats } from "../../lib/queries";
import { galleryHref } from "../../lib/imageFilter";

/**
 * Work waiting in the library, each row a shortcut into the gallery already
 * filtered to it.
 */
export function ToReview({ className }: { className?: string }) {
  const { data: cov } = useAiCoverage();
  const { data: stats } = useImageStats();
  const rows: Array<{ icon: LucideIcon; label: string; count?: number; to: string }> = [
    { icon: Sparkles, label: "Not AI-tagged", count: cov?.untagged, to: galleryHref({ noAiTags: true }) },
    { icon: Tag, label: "No tags at all", count: cov?.no_tags, to: galleryHref({ noTags: true }) },
    { icon: ShieldOff, label: "Quarantined", count: stats?.quarantined, to: galleryHref({ quarantined: true }) },
  ];
  return (
    <Section title="To review" className={className}>
      <ul className="-mx-2">
        {rows.map(({ icon: Icon, label, count, to }) => (
          <li key={label}>
            <Link
              to={to}
              className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm text-neutral-200 hover:bg-white/5"
            >
              <Icon size={16} className="text-faint shrink-0" />
              <span className="flex-1">{label}</span>
              {count == null ? (
                <Skeleton className="h-4 w-10" />
              ) : (
                <span className={count ? "tabular-nums text-neutral-100" : "tabular-nums text-faint"}>
                  {count.toLocaleString()}
                </span>
              )}
              <ChevronRight size={14} className="text-faint shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
