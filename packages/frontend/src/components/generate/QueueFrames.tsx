import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { countdown } from "../../lib/queueClock";
import { useLiveQueue, type LiveLeg } from "./useLiveQueue";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type FrameState = "done" | "making" | "waiting";

/** Frames drawn per batch at most; the rest are a count. */
const MAX_FRAMES = 12;

/** A batch's frames: on the one being made, its done images (the last few),
 * the one in the works and the rest; on a waiting batch, only what it has
 * left. At most `max`, with how many more there are. */
export function framesOf(l: LiveLeg, max = MAX_FRAMES): { frames: { state: FrameState; key: number }[]; more: number } {
  const all: { state: FrameState; key: number }[] = [];
  // Of a long run's done images, the last two say enough.
  const from = l.running ? Math.max(0, l.finished - 2) : l.finished;
  for (let i = from; i < l.requests; i++) {
    all.push({ key: i, state: i < l.finished ? "done" : l.running && i === l.finished ? "making" : "waiting" });
  }
  return { frames: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** One image of the queue, `size` rem tall at its batch's shape: its
 * thumbnail once done (when the library has it), filling while made. */
export function Frame({ state, leg, i, size = 3, className }: { state: FrameState; leg: LiveLeg; i: number; size?: number; className?: string }) {
  const thumb = state === "done" ? leg.thumbs[i] : undefined;
  return (
    <span
      style={{ width: `${size * leg.aspect}rem`, height: `${size}rem` }}
      className={cn(
        "relative block shrink-0 overflow-hidden rounded-md",
        state === "done" && "bg-brand-500/70",
        state === "making" && "bg-brand-500/15 ring-1 ring-inset ring-brand-400",
        state === "waiting" && cn("border border-line-strong bg-raised/40", leg.guess && "border-dashed"),
        className,
      )}
    >
      {state === "making" && (
        <span className="absolute inset-x-0 bottom-0 bg-brand-400/70 transition-[height] duration-1000 ease-linear" style={{ height: `${leg.step * 100}%` }} />
      )}
      {thumb && <img src={thumb} alt="" className="h-full w-full object-cover" />}
    </span>
  );
}

/** A batch's frames in a row, then "+N" for the ones not drawn. */
export function FrameRow({ leg, size, max, className, frameClass }: { leg: LiveLeg; size?: number; max?: number; className?: string; frameClass?: string }) {
  const { frames, more } = framesOf(leg, max);
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {frames.map((f) => (
        <Frame key={f.key} state={f.state} leg={leg} i={f.key} size={size} className={frameClass} />
      ))}
      {more > 0 && <span className="pl-0.5 text-2xs tabular-nums text-faint">+{more}</span>}
    </span>
  );
}

/** "0:47 left" on the batch being made, "in 1:32" on the rest. */
export const legWhen = (l: LiveLeg, paused = false) =>
  paused ? (l.running ? "Paused" : "Waiting") : l.running ? `${countdown(l.left)} left` : `in ${countdown(l.startsIn)}`;

/**
 * The queue on the Generations page: every image to make as an empty frame
 * at its batch's shape, filling in with the thumbnail as it lands, and a
 * countdown for the whole queue and each batch. A batch whose time is a
 * guess has dashed frames. While ComfyUI can't be reached it stays, paused.
 */
export function QueueFrames() {
  const q = useLiveQueue(200);
  if (!q) return null;
  return (
    <section
      aria-label="Queue"
      className="relative mb-5 overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-brand-500/[0.07] via-surface to-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-neutral-50">{countdown(q.left)}</span>
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
