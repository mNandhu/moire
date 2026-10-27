import { useState } from "react";
import { ImageOff, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { cellTitle, failureLabel, resultGrid, resultSlots, shownSlot, slotKey, slotWhy, stepIndex, type ResultSlot } from "../../lib/batches";
import { useRetryRequest } from "../../hooks/useBatchActions";
import type { Batch, GenRequest } from "../../lib/generate";
import { cn } from "../../lib/cn";
import { smallThumb } from "../../lib/media";
import { ResultTile } from "./ResultTile";
import { WaitingCell } from "./RunningCell";

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
  const retry = useRetryRequest(batch._id, req._id, onChanged);
  const cancelled = req.state === "cancelled";
  return (
    <div
      className={cn(
        "flex flex-col gap-2 overflow-hidden rounded-lg border p-2.5 text-xs",
        cancelled ? "border-dashed border-line text-faint" : "border-red-900/60 bg-red-950/20",
      )}
      style={{ aspectRatio: ratio }}
    >
      <div className={cancelled ? "text-muted" : "text-red-200"}>
        {failureLabel(req)}
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

/** One cell of a batch: the image, its loader, or what went wrong. */
function SlotCell({ batch, s, ratio, onChanged }: { batch: Batch; s: ResultSlot; ratio: number; onChanged: (b?: Batch) => void }) {
  return s.kind === "image" ? (
    <ResultTile out={s.out} ratio={ratio} onChanged={() => onChanged()} />
  ) : s.kind === "waiting" ? (
    <WaitingCell batch={batch} req={s.req} first={s.first} ratio={ratio} onChanged={onChanged} />
  ) : (
    <FailedCell batch={batch} req={s.req} ratio={ratio} onChanged={onChanged} />
  );
}


/**
 * A batch's images. On a page, one grid of every request's cells in order:
 * images, the running and waiting ones, failed ones with Retry; a few images
 * stay big (one row fills the view, more wrap at four). In the output column,
 * see `PanelResults`.
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
  if (variant === "panel") {
    // Cells still waiting their turn are the queue deck's to show.
    const made = slots.filter((s) => s.kind !== "waiting" || s.req.state === "running");
    return <PanelResults batch={batch} slots={made} ratio={ratio} onChanged={onChanged} />;
  }
  const { cols, rows } = resultGrid(slots.length);
  // Rows fit the view's height.
  const cell = `calc((100vh - 12rem) / ${Math.min(rows, 2)} * ${ratio})`;
  return (
    <div className={cn("grid gap-2", cols === 1 && "justify-center")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, ${cell}))` }}>
      {slots.map((s, i) => (
        <div key={slotKey(s, i)} title={cellTitle(s)}>
          <SlotCell batch={batch} s={s} ratio={ratio} onChanged={onChanged} />
        </div>
      ))}
    </div>
  );
}

/**
 * The output column's batch: one cell big, as wide as the column allows
 * under the view's height, and the same size whatever the batch's count, so
 * results and loaders never resize the column. A batch of more than one gets
 * a strip of small ones under it to pick from (or ← →); until one is picked,
 * the big one follows the image being made, else the last one made.
 */
function PanelResults({
  batch,
  slots,
  ratio,
  onChanged,
}: {
  batch: Batch;
  slots: ResultSlot[];
  ratio: number;
  onChanged: (b?: Batch) => void;
}) {
  // The pick follows its image, not its place: cells come and go as a
  // running batch's requests finish.
  const [picked, setPicked] = useState<string | null>(null);
  const keys = slots.map(slotKey);
  const at = shownSlot(slots, picked);
  const s = slots[at];
  if (!s) return null;
  const many = slots.length > 1;
  const step = (d: number) => setPicked(keys[stepIndex(at, d, slots.length)]);
  return (
    <div
      className="[container-type:inline-size]"
      onKeyDown={(e) => {
        if (!many || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        step(e.key === "ArrowLeft" ? -1 : 1);
      }}
    >
      <div className="mx-auto" style={{ width: `min(100cqw, max(6rem, (100dvh - 22rem) * ${ratio}))` }} title={cellTitle(s)}>
        {/* Unkeyed: stepping swaps the image in place, so focus (and the
            arrow keys with it) stays on the tile. */}
        <SlotCell batch={batch} s={s} ratio={ratio} onChanged={onChanged} />
      </div>
      {many && (
        <div className="mt-2 flex flex-wrap justify-center gap-1.5" role="tablist" aria-label="Images in this batch">
          {slots.map((x, i) => (
            <button
              key={slotKey(x, i)}
              type="button"
              role="tab"
              aria-selected={i === at}
              title={cellTitle(x)}
              onClick={() => setPicked(keys[i])}
              className={cn(
                "relative h-14 overflow-hidden rounded-md transition-opacity",
                i === at ? "ring-2 ring-brand-400" : "opacity-70 ring-1 ring-line hover:opacity-100",
              )}
              style={{ aspectRatio: ratio }}
            >
              <StripThumb s={x} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A slot in the strip: the image, a loader, or a failure mark. */
function StripThumb({ s }: { s: ResultSlot }) {
  if (s.kind === "image" && s.out.thumb_url) {
    return (
      <img
        src={smallThumb(s.out.thumb_url)}
        alt=""
        loading="lazy"
        className={cn("h-full w-full object-cover", s.out.quarantined && "opacity-40 grayscale")}
      />
    );
  }
  return (
    <NoImageMark why={slotWhy(s)} className="h-full w-full" />
  );
}

/** In place of a thumbnail that isn't there, why: failed, on its way, or missing. */
function NoImageMark({
  why,
  className,
  style,
}: {
  why: "failed" | "running" | "waiting" | "missing";
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded border border-dashed",
        why === "failed" ? "border-red-900/70 text-red-300/80" : "border-line text-faint",
        why === "waiting" && "animate-pulse",
        className,
      )}
      style={style}
    >
      {why === "failed" ? (
        <TriangleAlert size={13} />
      ) : why === "running" ? (
        <Loader2 size={13} className="animate-spin" />
      ) : why === "missing" ? (
        <ImageOff size={13} />
      ) : null}
    </span>
  );
}
