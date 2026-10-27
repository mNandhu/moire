import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import type { QueueFrame } from "../../lib/generate";
import { clockText } from "../../lib/format";
import { useLiveQueue, type LiveLeg } from "./useLiveQueue";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Frames drawn per batch at most; the rest are a count. */
const MAX_FRAMES = 12;

/** A batch's frames: on the one being made, its last few made (or failed)
 * images, the ones in the works and the rest; on a waiting batch, only what
 * it has left. At most `max`, with how many more there are. */
function framesOf(l: LiveLeg, max = MAX_FRAMES): { frames: (QueueFrame & { key: number })[]; more: number } {
  const all = l.frames.map((f, key) => ({ ...f, key }));
  const open = all.filter((f) => f.state === "waiting" || f.state === "making");
  // Of a long run's made images, the last two say enough.
  const shown = l.running ? [...all.filter((f) => f.state === "done" || f.state === "failed").slice(-2), ...open] : open;
  return { frames: shown.slice(0, max), more: Math.max(0, shown.length - max) };
}

/** One image of the queue, `size` rem tall at its batch's shape: its
 * thumbnail once done and in the library, filling while made. */
function Frame({ frame, leg, size = 3, className }: { frame: QueueFrame; leg: LiveLeg; size?: number; className?: string }) {
  const { state, thumb } = frame;
  return (
    <span
      style={{ width: `${size * leg.aspect}rem`, height: `${size}rem` }}
      className={cn(
        "relative block shrink-0 overflow-hidden rounded-md",
        state === "done" && "bg-brand-500/70",
        state === "failed" && "border border-red-500/50 bg-red-500/10",
        state === "making" && "bg-brand-500/15 ring-1 ring-inset ring-brand-400",
        state === "waiting" && cn("border border-line-strong bg-raised/40", leg.guess && "border-dashed"),
        className,
      )}
    >
      {state === "making" && (
        <span className="absolute inset-x-0 bottom-0 bg-brand-400/70 transition-[height] duration-1000 ease-linear" style={{ height: `${leg.step * 100}%` }} />
      )}
      {state === "done" && thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
    </span>
  );
}

/** A batch's frames in a row, then "+N" for the ones not drawn. */
export function FrameRow({ leg, size, max, className, frameClass }: { leg: LiveLeg; size?: number; max?: number; className?: string; frameClass?: string }) {
  const { frames, more } = framesOf(leg, max);
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {frames.map((f) => (
        <Frame key={f.key} frame={f} leg={leg} size={size} className={frameClass} />
      ))}
      {more > 0 && <span className="pl-0.5 text-2xs tabular-nums text-faint">+{more}</span>}
    </span>
  );
}

/** "0:47 left" on the batch being made, "in 1:32" on the rest. */
export const legWhen = (l: LiveLeg, paused = false) =>
  paused ? (l.running ? "Paused" : "Waiting") : l.running ? `${clockText(l.left, "round")} left` : `in ${clockText(l.startsIn, "round")}`;

/**
 * The queue on the Generations page: every image to make as an empty frame
 * at its batch's shape, filling in with the thumbnail as it lands, and a
 * countdown for the whole queue and each batch. A batch whose time is a
 * guess has dashed frames. While ComfyUI can't be reached it stays, paused.
 */
export function QueueFrames() {
  const q = useLiveQueue();
  if (!q) return null;
  return (
    <section
      aria-label="Queue"
      className="relative mb-5 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-brand-500/[0.07] via-surface to-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-neutral-50">{clockText(q.left, "round")}</span>
          <span className="text-sm text-muted">{q.paused ? "paused, ComfyUI can't be reached" : "to go"}</span>
        </div>
        <span className="text-xs tabular-nums text-faint">
          {plural(q.images, "image")}, {plural(q.legs.length, "batch", "batches")}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3">
        {q.legs.map((l) => (
          <Link key={l.id} to={`/generations/${l.id}`} className="group min-w-24">
            <FrameRow leg={l} />
            <span className="mt-1 flex w-0 min-w-full items-baseline gap-1.5 text-2xs">
              <span className={cn("min-w-0 truncate", l.running ? "text-white" : "text-muted group-hover:text-neutral-100")}>{l.name}</span>
              <span className={cn("shrink-0 font-mono tabular-nums", l.running ? "text-brand-200" : "text-faint")}>{legWhen(l, q.paused)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
