import { useContext } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UndoActionContext } from "@/features/generate/lib/undoActions";
import { Link } from "react-router-dom";
import {
  batchProgress,
  isFailedSlot,
  isHiddenSlot,
  isWaiting,
  rejectedIds,
  resultSlots,
  shownImages,
  turnLabel,
} from "@/features/generate/lib/batches";
import { durationWords } from "@/lib/format";
import { useBatchChanged } from "@/features/generate/hooks/useBatchActions";
import { BATCHES_KEY, STATUS_KEY, batchKey, clearFailed, useBatch, useBatchList, useBatches, useComfyStatus, type Batch, type BatchSummary } from "@/features/generate/lib/generate";
import { useToast } from "@/components/ui/Toasts";
import { BrushCleaning, TriangleAlert, X } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";

/** A batch's count pill (rejected or failed images) that clears them. */
function ClearChip({
  kind,
  n,
  label,
  onClick,
  disabled,
}: {
  kind: "rejected" | "failed";
  n: number;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={kind === "failed" ? "Removed from the batch for good" : "Hidden here only"} bubble>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-raised/60 pl-1 pr-2 text-xs text-muted transition-colors hover:border-line-strong hover:text-neutral-100 disabled:opacity-50"
      >
        <span
          className={cn(
            "grid h-4 w-4 place-items-center rounded-full",
            kind === "failed" ? "bg-amber-500/15 text-amber-300" : "bg-red-500/15 text-red-300",
          )}
        >
          {kind === "failed" ? <TriangleAlert size={10} strokeWidth={2.5} /> : <X size={10} strokeWidth={3} />}
        </span>
        <span className="tabular-nums">
          {n} {kind}
        </span>
      </button>
    </Tooltip>
  );
}

/** The column's Clear: a sweep, as it only tidies the view. */
function ClearIcon({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Clear the column (batches still running stay)" bubble>
      <button
        type="button"
        onClick={onClick}
        aria-label="Clear output"
        className="grid h-6 w-6 place-items-center rounded-full text-muted transition-colors hover:bg-line hover:text-neutral-100"
      >
        <BrushCleaning size={14} />
      </button>
    </Tooltip>
  );
}
import { StepListContext, useStepList } from "@/lib/stepList";
import { leftLabel } from "@/features/generate/lib/eta";
import { queueRoles } from "@/features/generate/lib/queueClock";
import { useLocalPref } from "@/hooks/useLocalPref";
import { BatchResults } from "./BatchResults";

/** Batches shown in the output column. */
const SHOWN = 3;
/** When the column was last cleared (the newest batch's created_at then:
 * the server's clock, and ids can be reused), and the batches still in the
 * queue then (they stay, finished or not). */
const CLEARED_KEY = "generate:output-cleared-at";
type Cleared = { at: number; keep: number[] };
const NOT_CLEARED: Cleared = { at: 0, keep: [] };
const parseCleared = (raw: string): Cleared | undefined => {
  const v = JSON.parse(raw) as Partial<Cleared> | null;
  return v && typeof v.at === "number" && Array.isArray(v.keep) ? { at: v.at, keep: v.keep.filter((n) => typeof n === "number") } : undefined;
};
/** Rejected images cleared from the column (here only: they stay in the
 * library's Quarantined view and on the batch page). */
const HIDDEN_KEY = "generate:output-hidden-rejected";
const parseHidden = (raw: string): string[] | undefined => {
  const v = JSON.parse(raw) as unknown;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
};
const NONE_HIDDEN: string[] = [];

type PanelClears = { onHide: (ids: string[]) => void; onDropFailed: (id: number) => void; busy: boolean };

function BatchPanel({ id, hidden, clears }: { id: number; hidden: ReadonlySet<string>; clears: PanelClears }) {
  const { data: b } = useBatch(id);
  const changed = useBatchChanged(id);
  const { data: status } = useComfyStatus();
  if (!b) return null;
  // Every image of it cleared, nothing else to show.
  if (resultSlots(b).every((s) => isHiddenSlot(s, hidden))) return null;
  const { done, took, left } = batchProgress(b.requests);
  // With others queued its own time left isn't when it's done: the queue's
  // word for it first.
  const turn = status?.active.find((a) => a._id === id);
  const leftText = turn ? turnLabel(turn) : left && leftLabel(left);
  // What its pills clear.
  const rejected = rejectedIds([b]).filter((x) => !hidden.has(x));
  const failed = resultSlots(b).filter(isFailedSlot).length;
  return (
    // No card: a frame sized to the column sat wider than a portrait batch.
    <section aria-label={b.name}>
      <div className="mb-1.5 flex items-center gap-2 px-2 text-sm">
        <span className="min-w-0 truncate font-medium text-neutral-100">
          {b.name}
        </span>
        {done < b.requests.length && (
          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
            {done} / {b.requests.length}
          </span>
        )}
        {leftText ? (
          <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted">{leftText}</span>
        ) : (
          !turn &&
          took && (
            <span
              className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted"
            >
              {durationWords(took.total)}
            </span>
          )
        )}
        <span className="flex-1" />
        {rejected.length > 0 && (
          <ClearChip kind="rejected" n={rejected.length} label={`Clear ${rejected.length} rejected`} onClick={() => clears.onHide(rejected)} />
        )}
        {failed > 0 && (
          <ClearChip kind="failed" n={failed} label={`Clear ${failed} failed`} onClick={() => clears.onDropFailed(b._id)} disabled={clears.busy} />
        )}
        <Link to={`/generations/${b._id}`} className="shrink-0 text-xs text-muted hover:text-neutral-100">
          Batch page
        </Link>
      </div>
      <BatchResults batch={b} onChanged={changed} variant="panel" hidden={hidden} />
    </section>
  );
}

/**
 * The output column under the queue deck: the last few batches that have
 * started, newest on top, each with its images big as they're made. A batch
 * still waiting its turn is only in the deck. Clear, at its top, empties it (here only,
 * nothing is deleted) of all but a batch still running. Each batch's count
 * pills clear its rejected images (here only too) and remove its failed
 * requests for good.
 */
export function OutputFeed() {
  const { data: status } = useComfyStatus();
  // Waiting its turn: in the queue, nothing made, and not the one in front
  // (which may sit queued in ComfyUI a moment before it runs).
  const active = (status?.active ?? []).filter((a) => !a.test);
  const queued = queueRoles(active).behind;
  const behind = new Set(active.filter((a) => isWaiting(a) && queued.has(a._id)).map((a) => a._id));
  // Enough to get past every one of them, and past batches whose every
  // image was cleared away.
  const { data } = useBatches(2 * SHOWN + behind.size);
  const [cleared, setCleared] = useLocalPref<Cleared>(CLEARED_KEY, NOT_CLEARED, { parse: parseCleared });
  const [hiddenList, setHidden] = useLocalPref<string[]>(HIDDEN_KEY, NONE_HIDDEN, { parse: parseHidden });
  const hidden = new Set(hiddenList);
  const kept = new Set([...cleared.keep, ...active.map((a) => a._id)]);
  const candidates = (data ?? [])
    .filter((b) => {
      // Cancelled with nothing made: nothing to show (Generations lists it).
      if (b.state === "cancelled" && b.images === 0) return false;
      if (b.created_at <= cleared.at && !kept.has(b._id)) return false;
      return !behind.has(b._id);
    })
    .slice(0, 2 * SHOWN);
  const details = useBatchList(candidates.map((b) => b._id));
  const detailOf = (id: number) => details.find((d) => d?._id === id);
  // A batch with every image cleared away gives its place to an older one.
  const started = data
    ? candidates
        .filter((b) => {
          const d = detailOf(b._id);
          return !d || !resultSlots(d).every((s) => isHiddenSlot(s, hidden));
        })
        .slice(0, SHOWN)
    : undefined;
  // What an image opened from here steps through: the images on show, in
  // the order they were made (the column puts the newest batch on top).
  const shown = (started ?? []).map((b) => detailOf(b._id)).reverse();
  const steps = useStepList("generate", shownImages(shown, hidden));
  // Kept while their batch is still among the last few; older ones go.
  const stillRejected = new Set(rejectedIds(details));
  const qc = useQueryClient();
  const toast = useToast();
  const dropFailed = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(async (id) => [id, await clearFailed(id)] as const)),
    onSuccess: (done) => {
      // A batch with nothing left was deleted: out of the lists at once,
      // its own query dropped rather than refetched into a 404.
      const gone = new Set(done.filter(([, b]) => !b).map(([id]) => id));
      qc.setQueriesData<BatchSummary[]>({ queryKey: BATCHES_KEY }, (old) => old?.filter((b) => !gone.has(b._id)));
      for (const [id, b] of done) {
        if (b) qc.setQueryData<Batch>(batchKey(id), b);
        else qc.removeQueries({ queryKey: batchKey(id), exact: true });
      }
    },
    onError: (e) => toast.push(e.message, "error"),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    },
  });
  // Both undoable with the page's Ctrl+Z: each puts back what was there.
  const pushUndo = useContext(UndoActionContext);
  // Each goes back only from what it set: a change since (another tab, a
  // later Clear) is left alone.
  const undoable = <T,>(set: (v: T | ((prev: T) => T)) => void, was: T, now: T) => {
    const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
    set(now);
    pushUndo?.({
      undo: () => set((cur) => (same(cur, now) ? was : cur)),
      redo: () => set((cur) => (same(cur, was) ? now : cur)),
    });
  };
  // Only the last few batches': older ids would pile up.
  const hideRejected = (ids: string[]) =>
    undoable(setHidden, hiddenList, [...new Set([...hiddenList.filter((id) => stillRejected.has(id)), ...ids])]);
  const clearAll = () =>
    undoable(setCleared, cleared, {
      at: Math.max(cleared.at, ...(data ?? []).map((b) => b.created_at)),
      keep: [
        ...active.map((a) => a._id),
        ...(data ?? []).filter((b) => b.state === "running" || b.state === "paused").map((b) => b._id),
      ],
    });
  if (!started?.length) return null;
  return (
    <StepListContext.Provider value={steps}>
      {/* Up top, where the batches start: the whole column; each batch
          clears its own rejected and failed images. */}
      <div className="-mb-2 flex justify-end px-2">
        <ClearIcon onClick={clearAll} />
      </div>
      {started.map((b) => (
        <BatchPanel
          key={b._id}
          id={b._id}
          hidden={hidden}
          clears={{ onHide: hideRejected, onDropFailed: (id) => dropFailed.mutate([id]), busy: dropFailed.isPending }}
        />
      ))}
      <div className="flex justify-center">
        <Link to="/generations" className="text-xs text-muted hover:text-neutral-100">
          All generations
        </Link>
      </div>
    </StepListContext.Provider>
  );
}
