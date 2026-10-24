import { X } from "lucide-react";
import { useCancelRequest } from "../../hooks/useBatchActions";
import { cn } from "../../lib/cn";
import { cellProgress } from "../../lib/eta";
import type { Batch, GenRequest } from "../../lib/generate";
import { useLiveSeconds } from "../../hooks/useLiveSeconds";

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

export function WaitingCell({
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
  const cancel = useCancelRequest(batch._id, req._id, onChanged);
  const running = req.state === "running";
  const elapsed = useLiveSeconds(running ? req.elapsed : null, running);
  // Every cell of a running request develops together (one request makes
  // all its images at once); only the first carries Cancel.
  const { big, caption, tip, progress, fill, late, striped } = cellProgress(req, elapsed);
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
          <RunBar value={progress} striped={striped} late={late} />
        </div>
      )}
    </div>
  );
}
