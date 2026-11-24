import { useMemo } from "react";
import { Plus } from "lucide-react";
import { PageHeader, PageBody } from "@/app/components/PageHeader";
import { ButtonLink } from "@/components/ui/Button";
import { useImageStats } from "@/features/images/lib/queries";
import { DEFAULT_FILTERS } from "@/features/images/lib/imageFilter";
import { useImageFeed } from "@/features/images/hooks/useImageFeed";
import { useLibraries } from "@/features/library/lib/libraries";
import { useTagAggregate } from "@/features/tags/lib/queries";
import { LatestSession } from "@/features/overview/components/LatestSession";
import { RecentSessions } from "@/features/overview/components/RecentSessions";
import { ActivityPanel } from "@/features/overview/components/ActivityPanel";
import { LibraryHealth } from "@/features/overview/components/LibraryHealth";
import { latestDay, splitSessions } from "@/features/overview/lib/sessions";

// The newest images the sessions are cut from: weeks of work for most, and
// one request. The oldest session, likely cut short, is left out.
const RECENT = 400;
// Stacks on the Earlier sessions shelf.
const SHELF_SESSIONS = 20;

/**
 * Overview: what was made lately and what is waiting. The latest day's work
 * leads, then the sessions before it by day; activity and the library's
 * state close the page. (Discover is for wandering; this is for catching up.)
 */
export default function OverviewPage() {
  const libsQuery = useLibraries();
  // null = still loading; a failed load reads as empty.
  const libs = libsQuery.data ?? (libsQuery.isError ? [] : null);
  const tagsQuery = useTagAggregate();
  const { data: stats } = useImageStats();
  const feed = useImageFeed(DEFAULT_FILTERS, RECENT);
  const firstPage = feed.data?.pages[0];
  const { latest, earlier } = useMemo(
    () => latestDay(firstPage ? splitSessions(firstPage.items, !firstPage.next) : []),
    [firstPage],
  );
  const total = libs ? libs.reduce((n, l) => n + (l.indexed_count || 0), 0) : undefined;
  return (
    <>
      <PageHeader
        title="Overview"
        width="wide"
        actions={
          <ButtonLink to="/libraries" aria-label="Add library">
            <Plus size={16} /> <span className="hidden sm:inline">Add library</span>
          </ButtonLink>
        }
      />
      <PageBody width="wide">
        <div className="space-y-6">
          <LatestSession
            session={latest}
            pending={feed.isPending}
            failed={feed.isError}
            onRetry={() => void feed.refetch()}
          />
          <RecentSessions sessions={earlier.slice(0, SHELF_SESSIONS)} pending={feed.isPending} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <ActivityPanel days={stats?.activity} total={total} className="lg:col-span-2" />
            <LibraryHealth libs={libs} tagCount={tagsQuery.isError ? null : tagsQuery.data?.length} />
          </div>
        </div>
      </PageBody>
    </>
  );
}
