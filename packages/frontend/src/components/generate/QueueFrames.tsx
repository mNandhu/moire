import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import { countdown } from "../../lib/queueClock";
import { useLiveQueue, type LiveLeg } from "./useLiveQueue";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type FrameState = "done" | "making" | "waiting";

/** A batch's frames: on the one being made, its done images, the one in
 * the works and the rest; on a waiting batch, only what it has left. */
export function framesOf(l: LiveLeg): { state: FrameState; key: number }[] {
  const out: { state: FrameState; key: number }[] = [];
  for (let i = l.running ? 0 : l.finished; i < l.requests; i++) {
    out.push({ key: i, state: i < l.finished ? "done" : l.running && i === l.finished ? "making" : "waiting" });
  }
  return out;
}

/** One image of the queue: its thumbnail once done, filling while made. */
export function Frame({ state, leg, i, className }: { state: FrameState; leg: LiveLeg; i: number; className?: string }) {
  const thumb = state === "done" ? leg.thumbs[i] : undefined;
  return (
    <span
      style={{ width: `${3 * leg.aspect}rem` }}
      className={cn(
        "relative block h-12 shrink-0 overflow-hidden rounded-md",
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

/** "0:47 left" on the batch being made, "in 1:32" on the rest. */
export const legWhen = (l: LiveLeg) => (l.running ? `${countdown(l.left)} left` : `in ${countdown(l.startsIn)}`);

/**
 * The queue on the Generations page: every image to make as an empty frame
 * at its batch's shape, filling in with the thumbnail as it lands, and a
 * countdown for the whole queue and each batch. A batch whose time is a
 * guess has dashed frames.
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
          <span className="font-mono text-4xl font-semibold leading-none tabular-nums text-neutral-50">{countdown(q.left)}</span>
          <span className="text-sm text-muted">to go</span>
        </div>
        <span className="text-xs tabular-nums text-faint">
          {plural(q.images, "image")}, {plural(q.legs.length, "batch", "batches")}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-3">
        {q.legs.map((l) => (
          <Link key={l.id} to={`/generations/${l.id}`} className="group min-w-24">
            <span className="flex gap-1">
              {framesOf(l).map((f) => (
                <Frame key={f.key} state={f.state} leg={l} i={f.key} />
              ))}
            </span>
            <span className="mt-1 flex w-0 min-w-full items-baseline gap-1.5 text-2xs">
              <span className={cn("min-w-0 truncate", l.running ? "text-white" : "text-muted group-hover:text-neutral-100")}>{l.name}</span>
              <span className={cn("shrink-0 font-mono tabular-nums", l.running ? "text-brand-200" : "text-faint")}>{legWhen(l)}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
