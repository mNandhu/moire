import { Fragment } from "react";
import { Link } from "react-router-dom";
import { Clock, Layers } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";
import type { FeedItem } from "@/features/images/lib/imageFilter";
import { DiscoverSection, SHELF, ShelfImage } from "@/features/discover/components/DiscoverSection";
import { useOpenIn } from "@/features/overview/components/LatestSession";
import { bestOf, byDay, sessionContext, sessionSpan, type Session } from "@/features/overview/lib/sessions";

const TILE =
  "group relative block aspect-[3/4] w-36 shrink-0 overflow-hidden rounded-xl bg-white/[0.06] shadow-tile ring-brand-400 focus-visible:outline-none focus-visible:ring-2 sm:w-40";

/** One session: its best image, the count on a stack when there are more,
 * when it ran. Opens the image view stepping through the session. */
function SessionTile({ session }: { session: Session<FeedItem> }) {
  const n = session.items.length;
  const best = bestOf(session.items)!;
  const open = useOpenIn(`overview:session:${session.end}`, session.items, sessionContext(session));
  return (
    <div className="relative shrink-0 snap-start pt-2">
      {/* The rest of the session behind its best image: two cards, fanned up. */}
      {n > 1 && (
        <>
          <span aria-hidden className="absolute inset-x-3 top-0 bottom-2 rounded-xl bg-white/[0.07] ring-1 ring-white/5" />
          <span aria-hidden className="absolute inset-x-1.5 top-1 bottom-1 rounded-xl bg-white/[0.1] ring-1 ring-white/5" />
        </>
      )}
      <Link {...open(best)} className={TILE} aria-label={`${n} ${n === 1 ? "image" : "images"}, ${sessionSpan(session)}`}>
        {best.thumb_url && <ShelfImage src={best.thumb_url} blurhash={best.blurhash} />}
        {n > 1 && (
          <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-brand-100 backdrop-blur-sm">
            <Layers size={11} /> {n}
          </span>
        )}
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2.5 pb-1.5 pt-8 text-xs font-medium tabular-nums text-neutral-200">
          {sessionSpan(session)}
        </span>
      </Link>
    </div>
  );
}

/**
 * The sessions before the latest one, under the day they ran: a week of
 * work at a glance, each session one stack rather than its every image.
 */
export function RecentSessions({ sessions, pending }: { sessions: Session<FeedItem>[]; pending: boolean }) {
  if (!pending && !sessions.length) return null;
  const days = byDay(sessions, (s) => s.end);
  return (
    <DiscoverSection
      label="Earlier sessions"
      icon={Clock}
      tint="violet"
      cover={sessions[0] ? bestOf(sessions[0].items)?.thumb_url : undefined}
      viewAll="/"
    >
      <div className={cn(SHELF, "gap-6")}>
        {pending
          ? Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="pt-2">
                <Skeleton className={TILE} />
              </div>
            ))
          : days.map(({ day, items: run }, i) => (
              <Fragment key={day}>
                {i > 0 && <div aria-hidden className="w-px shrink-0 self-stretch bg-white/10" />}
                <div className="shrink-0" role="group" aria-label={day}>
                  <p className="mb-1 text-sm font-semibold text-neutral-200">{day}</p>
                  <div className="flex gap-3">
                    {run.map((s) => (
                      <SessionTile key={s.end ?? s.items[0]._id} session={s} />
                    ))}
                  </div>
                </div>
              </Fragment>
            ))}
      </div>
    </DiscoverSection>
  );
}
