import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { countdown } from "../../lib/queueClock";
import { FrameRow, legWhen } from "./QueueFrames";
import { useLiveQueue, type LiveLeg } from "./useLiveQueue";

const url = (l: LiveLeg) => `/generations/${l.id}`;

function Tab({ depth, children, to }: { depth: number; children: ReactNode; to?: string }) {
  const cls = cn(
    "-mb-1.5 flex items-baseline gap-2 rounded-t-lg border border-b-0 border-line px-3 pb-2.5 pt-1 text-2xs",
    depth === 1 ? "bg-raised text-muted" : "bg-raised/50 text-faint",
    to && "hover:text-neutral-100",
  );
  const style = { marginInline: depth * 8 };
  return to ? (
    <Link to={to} style={style} className={cls}>
      {children}
    </Link>
  ) : (
    <div style={style} className={cls}>
      {children}
    </div>
  );
}

/**
 * The Generate page's queue as a deck: the batch being made in front (its
 * frames filling in, its time left), the next one and a count of the rest
 * peeking out behind it. An empty slot when nothing is queued.
 */
export function QueueDeck() {
  const q = useLiveQueue();
  // Always there, so it doesn't pop in with the first batch and out with the last.
  if (!q) {
    return (
      <div className="flex h-[3.25rem] items-center justify-center rounded-xl border border-dashed border-line text-sm text-faint">
        Nothing in queue
      </div>
    );
  }
  const [head, after, ...rest] = q.legs;
  return (
    <div>
      {rest.length > 0 && (
        <Tab depth={2}>
          <span className="flex-1">
            +{rest.length} more {rest.length === 1 ? "batch" : "batches"}
          </span>
          <span className="font-mono tabular-nums">{q.paused ? "paused" : `all done in ${countdown(q.left)}`}</span>
        </Tab>
      )}
      {after && (
        <Tab depth={1} to={url(after)}>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-faint">Next</span> {after.name}
          </span>
          <span className="shrink-0 font-mono tabular-nums">{legWhen(after, q.paused)}</span>
        </Tab>
      )}
      <Link to={url(head)} className="relative flex items-center gap-3 rounded-xl border border-brand-400/40 bg-surface px-3 py-2 shadow-panel hover:border-brand-400/70">
        <FrameRow leg={head} size={2} max={6} className="shrink-0 gap-0.5" frameClass="rounded" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-neutral-100">{head.name}</span>
          <span className="block font-mono text-xs tabular-nums text-brand-200">{legWhen(head, q.paused)}</span>
        </span>
      </Link>
    </div>
  );
}
