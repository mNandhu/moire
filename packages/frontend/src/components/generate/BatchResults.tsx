import { Link, useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { Loader2, RotateCcw, Star, X } from "lucide-react";
import { ProgressBar } from "../ui";
import { resultGrid, resultSlots, type ResultSlot } from "../../lib/batches";
import { cancelRequest, retryRequest, thumbUrl, type Batch, type GenRequest, type Output } from "../../lib/generate";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { withBackgroundLocation } from "../../lib/backgroundLocation";
import { cn } from "../../lib/cn";
import { useToast } from "../Toasts";

export function Tile({ out, ratio, onChanged }: { out: Output; ratio: number; onChanged: () => void }) {
  const location = useLocation();
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!out.in_library) return;
    const k = e.key.toLowerCase();
    if (k === "k") void act(() => setQuarantine(out.image_id, false));
    else if (k === "x") void act(() => setQuarantine(out.image_id, true));
    else if (/^[1-5]$/.test(k)) void act(() => setScore(out.image_id, Number(k)));
  };
  if (!out.in_library) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint"
        style={{ aspectRatio: ratio }}
        title={out.filename}
      >
        <Loader2 size={14} className="mr-1.5 animate-spin" /> Scanning
      </div>
    );
  }
  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      title="K keep · X reject · 1 to 5 score"
      className={cn(
        "group relative overflow-hidden rounded-lg bg-raised outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        out.quarantined && "opacity-60",
      )}
      style={{ aspectRatio: ratio }}
    >
      <Link to={`/image/${encodeURIComponent(out.image_id)}`} state={withBackgroundLocation(location)} tabIndex={-1}>
        <img src={thumbUrl(out.image_id)} alt="" loading="lazy" className="h-full w-full object-cover" />
      </Link>
      {out.quarantined && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-black/60 px-2 py-1 text-xs">
          <span className="text-red-200">Rejected</span>
          <button type="button" className="text-neutral-100 hover:underline" onClick={() => act(() => setQuarantine(out.image_id, false))}>
            Restore
          </button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Score ${n}`}
            onClick={() => act(() => setScore(out.image_id, n))}
            className="text-neutral-300 hover:text-amber-300"
          >
            <Star size={14} className={cn((out.score ?? 0) >= n && "fill-amber-300 text-amber-300")} />
          </button>
        ))}
        <span className="flex-1" />
        {!out.quarantined && (
          <button
            type="button"
            aria-label="Reject"
            title="Reject"
            onClick={() => act(() => setQuarantine(out.image_id, true))}
            className="rounded p-0.5 text-neutral-300 hover:text-red-300"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function cellTitle(s: ResultSlot): string {
  return `Request ${s.number}, seed ${s.req.seed}`;
}

function WaitingCell({
  batch,
  req,
  first,
  ratio,
  onChanged,
}: {
  batch: Batch;
  req: GenRequest;
  first: boolean;
  ratio: number;
  onChanged: (b?: Batch) => void;
}) {
  const cancel = useMutation({ mutationFn: () => cancelRequest(batch._id, req._id), onSuccess: (b) => onChanged(b) });
  const running = req.state === "running";
  const pct = req.progress && req.progress.max ? (req.progress.value / req.progress.max) * 100 : 0;
  return (
    <div
      className={cn(
        "relative flex flex-col justify-end overflow-hidden rounded-lg p-2",
        running ? "border border-brand-700/70 bg-raised" : "bg-raised/50",
      )}
      style={{ aspectRatio: ratio }}
    >
      <div className={cn("absolute inset-0", running ? "animate-pulse bg-brand-900/10" : "bg-raised/40")} />
      {first && (
        <div className="relative space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={running ? "text-neutral-100" : "text-muted"}>
              {running
                ? req.progress?.node
                  ? `${req.progress.node} ${req.progress.value} / ${req.progress.max}`
                  : req.progress
                    ? `${req.progress.value} / ${req.progress.max}`
                    : "Running"
                : req.state === "queued"
                  ? "Queued"
                  : "Waiting"}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Cancel"
              title="Cancel"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
            >
              <X size={13} />
            </button>
          </div>
          {running && <ProgressBar value={pct} />}
        </div>
      )}
    </div>
  );
}

function FailedCell({
  batch,
  req,
  ratio,
  onChanged,
}: {
  batch: Batch;
  req: GenRequest;
  ratio: number;
  onChanged: (b?: Batch) => void;
}) {
  const retry = useMutation({
    mutationFn: (single: boolean) => retryRequest(batch._id, req._id, single),
    onSuccess: (b) => onChanged(b),
  });
  const cancelled = req.state === "cancelled";
  const empty = req.state === "done";
  return (
    <div
      className={cn(
        "flex flex-col gap-2 overflow-hidden rounded-lg border p-2.5 text-xs",
        cancelled ? "border-dashed border-line text-faint" : "border-red-900/60 bg-red-950/20",
      )}
      style={{ aspectRatio: ratio }}
    >
      <div className={cancelled ? "text-muted" : "text-red-200"}>
        {cancelled
          ? "Cancelled"
          : empty
            ? "Returned 0 images"
            : req.state === "lost"
              ? "Lost"
              : `Failed${req.images && req.images > 1 ? `, ${req.images} images` : ""}`}
      </div>
      {req.error && (
        <div className="min-h-0 flex-1 overflow-hidden break-words font-mono text-red-300">
          {req.error.class_type} {req.error.node && <span className="text-faint">node {req.error.node}</span>}
          <div className="mt-0.5">
            {req.error.type ? `${req.error.type}: ` : ""}
            {req.error.message}
          </div>
        </div>
      )}
      {!cancelled && (
        <div className="mt-auto flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => retry.mutate(false)}
            disabled={retry.isPending}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-neutral-100 hover:border-line-strong"
          >
            <RotateCcw size={12} /> Retry
          </button>
          {req.images != null && req.images > 1 && (
            <button
              type="button"
              onClick={() => retry.mutate(true)}
              disabled={retry.isPending}
              className="rounded-md px-2 py-1 text-muted hover:text-neutral-100"
            >
              One at a time
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A batch's images as one grid, every request's cells in order: images, the
 * running and waiting ones, failed ones with Retry. On a page a few images
 * stay big (one row fills the view, more wrap at four); in the output
 * column the cells shrink so the batch fits under the window's height.
 */
export function BatchResults({
  batch,
  onChanged,
  variant = "page",
}: {
  batch: Batch;
  onChanged: (b?: Batch) => void;
  variant?: "page" | "panel";
}) {
  const ratio = batch.inputs.width && batch.inputs.height ? batch.inputs.width / batch.inputs.height : 2 / 3;
  const slots = resultSlots(batch);
  const { cols, rows } = resultGrid(slots.length, variant);
  // Size cells so the rows fit the view's height; the output column also
  // leaves room for its header and the recent batches under it.
  const cell =
    variant === "page"
      ? `calc((100vh - 12rem) / ${Math.min(rows, 2)} * ${ratio})`
      : `calc((100dvh - 26rem) / ${rows} * ${ratio})`;
  return (
    <div className={cn("grid gap-2", variant === "panel" && "justify-center")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, ${cell}))` }}>
      {slots.map((s) => (
        <div key={s.kind === "image" ? `${s.req._id}:${s.out.idx}` : `${s.req._id}:${s.kind}:${slots.indexOf(s)}`} title={cellTitle(s)}>
          {s.kind === "image" ? (
            <Tile out={s.out} ratio={ratio} onChanged={() => onChanged()} />
          ) : s.kind === "waiting" ? (
            <WaitingCell batch={batch} req={s.req} first={s.first} ratio={ratio} onChanged={onChanged} />
          ) : (
            <FailedCell batch={batch} req={s.req} ratio={ratio} onChanged={onChanged} />
          )}
        </div>
      ))}
    </div>
  );
}
