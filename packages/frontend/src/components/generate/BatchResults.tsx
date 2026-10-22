import { Link, useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ImageOff, Loader2, RotateCcw, Undo2, X } from "lucide-react";
import { resultGrid, resultSlots, type ResultSlot } from "../../lib/batches";
import { cancelRequest, retryRequest, type Batch, type GenRequest, type Output } from "../../lib/generate";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { withBackgroundLocation } from "../../lib/backgroundLocation";
import { cn } from "../../lib/cn";
import { clock, runProgress } from "../../lib/eta";
import { useLiveSeconds } from "../../hooks/useLiveSeconds";
import { useToast } from "../Toasts";
import { ScorePicker } from "../ui/ScoreMark";

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
    // A rejected image is out; it takes a score once restored.
    else if (/^[1-5]$/.test(k) && !out.quarantined) void act(() => setScore(out.image_id, Number(k)));
  };
  if (!out.in_library) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint"
        style={{ aspectRatio: ratio }}
        title={out.filename}
      >
        {out.arriving ? (
          <>
            <Loader2 size={14} className="mr-1.5 animate-spin" /> Scanning
          </>
        ) : (
          <>
            <ImageOff size={14} className="mr-1.5" /> Not in the library
          </>
        )}
      </div>
    );
  }
  const rejected = !!out.quarantined;
  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      title={rejected ? "K restore" : "K keep · X reject · 1 to 5 score"}
      className="group relative overflow-hidden rounded-lg bg-raised outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      style={{ aspectRatio: ratio }}
    >
      <Link to={`/image/${encodeURIComponent(out.image_id)}`} state={withBackgroundLocation(location)} tabIndex={-1}>
        {out.thumb_url && (
          <img
            src={out.thumb_url}
            alt=""
            loading="lazy"
            className={cn("h-full w-full object-cover transition-[opacity,filter]", rejected && "opacity-40 grayscale")}
          />
        )}
      </Link>
      {/* Rejected reads as a state on the picture, not a bar across it. */}
      {rejected && (
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-black/65 px-2 py-0.5 text-2xs font-medium text-red-200">
          Rejected
        </span>
      )}
      {/* Scored, the mark stays at rest as on the gallery's tiles; the rest
          of the bar comes with the pointer. */}
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
          (rejected || !out.score) && "opacity-0",
        )}
      >
        {rejected ? (
          <button
            type="button"
            onClick={() => act(() => setQuarantine(out.image_id, false))}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-neutral-100 hover:text-white"
          >
            <Undo2 size={13} /> Restore
          </button>
        ) : (
          <>
            <ScorePicker value={out.score ?? 0} onSet={(n) => act(() => setScore(out.image_id, n))} size="sm" quiet />
            <span className="flex-1" />
            <button
              type="button"
              aria-label="Reject"
              title="Reject"
              onClick={() => act(() => setQuarantine(out.image_id, true))}
              className="rounded p-0.5 text-neutral-300 opacity-0 hover:text-red-300 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100"
            >
              <X size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function cellTitle(s: ResultSlot): string {
  return `Request ${s.number}, seed ${s.req.seed}`;
}

/** ComfyUI's own progress: "3 12 / 28" (node, then step of steps). */
function stepsLabel(req: GenRequest): string | null {
  if (!req.progress) return null;
  const steps = `${req.progress.value} / ${req.progress.max}`;
  return req.progress.node ? `${req.progress.node} ${steps}` : steps;
}

// The drifting colour under a generating tile: warm and violet on time,
// amber once it overruns.
const AURORA = {
  calm: "radial-gradient(55% 45% at 30% 25%, rgb(251 191 136 / 0.32), transparent 70%), radial-gradient(50% 45% at 72% 78%, rgb(129 140 248 / 0.34), transparent 70%), radial-gradient(40% 35% at 70% 30%, rgb(232 121 249 / 0.18), transparent 70%)",
  late: "radial-gradient(55% 45% at 30% 25%, rgb(251 191 36 / 0.30), transparent 70%), radial-gradient(50% 45% at 72% 78%, rgb(249 115 22 / 0.26), transparent 70%), radial-gradient(40% 35% at 70% 30%, rgb(244 63 94 / 0.14), transparent 70%)",
};

/** The tile's bar: ComfyUI's steps when it sends them, else the time
 * against the estimate; stripes once the estimate is passed or without one. */
function RunBar({ value, striped, late }: { value: number | null; striped: boolean; late: boolean }) {
  return (
    <div className="relative h-1 overflow-hidden rounded-full bg-white/10">
      {striped || value == null ? (
        <div
          className={cn("absolute inset-0 animate-stripes", late ? "opacity-90" : "opacity-60")}
          style={{
            backgroundImage: `repeating-linear-gradient(-45deg, ${late ? "rgb(251 191 36 / 0.85)" : "rgb(167 139 250 / 0.7)"} 0 6px, transparent 6px 12px)`,
            backgroundSize: "24px 100%",
          }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-brand-600 to-brand-300 shadow-[0_0_8px_rgb(167_139_250/0.8)] transition-[width] duration-300 ease-linear"
          style={{ width: `${Math.max(2, value * 100)}%` }}
        />
      )}
    </div>
  );
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
  const elapsed = useLiveSeconds(running ? req.elapsed : null, running);
  const run = running ? runProgress(req.expected, elapsed) : null;
  const steps = req.progress && req.progress.max ? req.progress.value / req.progress.max : null;
  const late = run?.phase === "late";
  // Every cell of a running request develops together (one request makes
  // all its images at once); only the first carries Cancel.
  // ComfyUI's steps when it sends them, else the time: one number for the
  // tile and its bar.
  const progress = steps ?? run?.fill ?? null;
  const fill = progress ?? 0;
  const big = !running
    ? null
    : run
      ? run.phase === "on-time"
        ? clock(Math.ceil(run.left))
        : `+${clock(run.over)}`
      : elapsed != null
        ? clock(elapsed)
        : null;
  // Waiting in Moiré's queue or ComfyUI's reads the same: queued.
  const caption = !running
    ? "Queued"
    : run
      ? run.phase === "on-time"
        ? "left"
        : late
          ? "Taking longer than usual"
          : "Finishing up"
      : (stepsLabel(req) ?? "Running");
  const tip = [stepsLabel(req), run && req.expected ? `Usually about ${clock(req.expected)}` : null].filter(Boolean).join(" · ");
  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-lg p-2 [container-type:inline-size]",
        running ? cn("border bg-raised", late ? "border-amber-600/60" : "border-brand-700/70") : "bg-raised/50",
      )}
      style={{ aspectRatio: ratio }}
      title={tip || undefined}
    >
      {running ? (
        <>
          <div
            aria-hidden
            className="absolute inset-0 transition-[opacity,filter] duration-1000 ease-linear"
            style={{ opacity: 0.6 + fill * 0.4, filter: `saturate(${0.5 + fill * 0.5})` }}
          >
            <div className="absolute -inset-1/4 animate-aurora" style={{ background: late ? AURORA.late : AURORA.calm }} />
          </div>
          {/* Developing from the bottom up: the part still to come stays dim,
              its edge a soft line of light. */}
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 bg-gradient-to-b from-canvas/60 via-canvas/30 to-transparent transition-[height] duration-1000 ease-linear"
            style={{ height: `${(1 - fill) * 100}%` }}
          />
          <div aria-hidden className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
        </>
      ) : (
        <div aria-hidden className="absolute inset-0 animate-pulse bg-raised/40" />
      )}
      {first && (
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
          className="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-muted hover:bg-black/30 hover:text-neutral-100"
        >
          <X size={13} />
        </button>
      )}
      <div className="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-center">
        {big && (
          <span
            className={cn(
              "font-semibold tabular-nums leading-none tracking-tight drop-shadow",
              "text-[clamp(1rem,22cqw,2rem)]",
              late ? "text-amber-200" : "text-neutral-50",
            )}
          >
            {big}
          </span>
        )}
        {(first || running) && (
          <span className={cn("text-xs leading-tight", late ? "text-amber-200/90" : running ? "text-neutral-200" : "text-muted")}>
            {caption}
          </span>
        )}
      </div>
      {running && (
        <div className="relative">
          <RunBar value={progress} striped={!!run && run.phase !== "on-time"} late={late} />
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
  const { cols, rows } = resultGrid(slots.length, variant, ratio);
  // Size cells so the rows fit the view's height (the output column leaves
  // room for what sits above them); the column's width caps them too, so a
  // single portrait fills it rather than sitting between empty bands.
  const cell =
    variant === "page"
      ? `calc((100vh - 12rem) / ${Math.min(rows, 2)} * ${ratio})`
      : `max(6rem, calc((100dvh - 17rem) / ${rows} * ${ratio}))`;
  return (
    <div className={cn("grid gap-2", (variant === "panel" || cols === 1) && "justify-center")} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, ${cell}))` }}>
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
