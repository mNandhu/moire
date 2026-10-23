import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { clockText } from "../../lib/format";
import { BATCHES_KEY, STATUS_KEY, batchKey, cancelBatch, useComfyStatus } from "../../lib/generate";
import { useToast } from "../Toasts";
import { FrameRow, legWhen } from "./QueueFrames";
import { useLiveQueue, type LiveLeg } from "./useLiveQueue";

const url = (l: LiveLeg) => `/generations/${l.id}`;

/** How long a batch that just joined the queue glows. */
const ARRIVAL_MS = 1600;

/** Takes a batch out of the queue. */
function CancelX({ id, className }: { id: number; className?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cancel = useMutation({
    mutationFn: () => cancelBatch(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
      // Its panel in the output column, which polls on its own.
      void qc.invalidateQueries({ queryKey: batchKey(id) });
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  return (
    <button
      type="button"
      aria-label="Cancel batch"
      title="Cancel batch"
      disabled={cancel.isPending}
      onClick={() => cancel.mutate()}
      className={cn("shrink-0 rounded p-0.5 text-faint hover:bg-red-500/15 hover:text-red-300 touch:p-1.5", className)}
    >
      <X size={12} />
    </button>
  );
}

/** A batch's tab peeking out behind the front card: a link to its page and,
 * beside it (not inside: no button in a link), its cancel. Or, with
 * `onClick`, the tab that unfolds the rest. */
function Tab({
  depth,
  children,
  to,
  cancel,
  onClick,
  lit,
}: {
  depth: number;
  children: ReactNode;
  to?: string;
  cancel?: number;
  onClick?: () => void;
  lit?: boolean;
}) {
  const cls = cn(
    "-mb-1.5 flex items-center gap-2 rounded-t-lg border border-b-0 border-line px-3 pb-2.5 pt-1 text-left text-2xs",
    depth === 1 ? "bg-raised text-muted" : "bg-raised/50 text-faint",
    lit && "animate-arrive",
  );
  const style: CSSProperties = { marginInline: depth * 8 };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} style={style} className={cn(cls, "w-[calc(100%-32px)] hover:text-neutral-100")}>
        {children}
      </button>
    );
  }
  return (
    <div style={style} className={cls}>
      <Link to={to!} className="flex min-w-0 flex-1 items-center gap-2 hover:text-neutral-100">
        {children}
      </Link>
      {cancel != null && <CancelX id={cancel} className="-my-1" />}
    </div>
  );
}

/** Batches that just joined the queue, for a moment; none for what was
 * already queued when the page opened (`ready`: the queue is known). */
function useArrivals(ids: number[], ready: boolean): Set<number> {
  const seen = useRef<Set<number> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (!ready) return;
    const now = key ? key.split(",").map(Number) : [];
    const before = seen.current;
    seen.current = new Set(now);
    const added = before ? now.filter((id) => !before.has(id)) : [];
    if (added.length) setFresh(new Set(added));
  }, [key, ready]);
  useEffect(() => {
    if (!fresh.size) return;
    const t = setTimeout(() => setFresh(new Set()), ARRIVAL_MS);
    return () => clearTimeout(t);
  }, [fresh]);
  return fresh as Set<number>;
}

/**
 * The Generate page's queue as a deck: the batch being made in front (its
 * frames filling in, its time left), the next one and a count of the rest
 * peeking out behind it; the count unfolds into a tab per batch. Each can be
 * cancelled from here. A batch just queued glows where it lands. An empty
 * slot when nothing is queued.
 */
export function QueueDeck() {
  const q = useLiveQueue();
  const { isSuccess } = useComfyStatus();
  const [open, setOpen] = useState(false);
  const fresh = useArrivals(q?.legs.map((l) => l.id) ?? [], isSuccess);
  // Always there, so it doesn't pop in with the first batch and out with the last.
  if (!q) {
    return (
      <div className="flex h-[3.25rem] items-center justify-center rounded-xl border border-dashed border-line text-sm text-faint">
        Nothing in queue
      </div>
    );
  }
  const [head, after, ...rest] = q.legs;
  const unfolded = open && rest.length > 0;
  return (
    <div>
      {rest.length > 0 && (
        <Tab depth={2} onClick={() => setOpen((o) => !o)} lit={!unfolded && rest.some((l) => fresh.has(l.id))}>
          <span className="flex-1">{unfolded ? "Show less" : `+${rest.length} more ${rest.length === 1 ? "batch" : "batches"}`}</span>
          <span className="font-mono tabular-nums">{q.paused ? "paused" : `all done in ${clockText(q.left, "round")}`}</span>
          <ChevronDown size={12} className={cn("transition-transform", unfolded && "rotate-180")} />
        </Tab>
      )}
      {/* Furthest back on top, like the deck's own order. */}
      {unfolded &&
        [...rest].reverse().map((l) => (
          <Tab key={l.id} depth={2} to={url(l)} cancel={l.id} lit={fresh.has(l.id)}>
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            <span className="shrink-0 font-mono tabular-nums">{legWhen(l, q.paused)}</span>
          </Tab>
        ))}
      {after && (
        <Tab depth={1} to={url(after)} cancel={after.id} lit={fresh.has(after.id)}>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-faint">Next</span> {after.name}
          </span>
          <span className="shrink-0 font-mono tabular-nums">{legWhen(after, q.paused)}</span>
        </Tab>
      )}
      <div
        className={cn(
          "relative flex items-center gap-3 rounded-xl border border-brand-400/40 bg-surface px-3 py-2 shadow-panel has-[a:hover]:border-brand-400/70",
          fresh.has(head.id) && "animate-arrive",
        )}
      >
        <Link to={url(head)} className="flex min-w-0 flex-1 items-center gap-3">
          <FrameRow leg={head} size={2} max={6} className="shrink-0 gap-0.5" frameClass="rounded" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-neutral-100">{head.name}</span>
            <span className="block font-mono text-xs tabular-nums text-brand-200">{legWhen(head, q.paused)}</span>
          </span>
        </Link>
        <CancelX id={head.id} />
      </div>
    </div>
  );
}
