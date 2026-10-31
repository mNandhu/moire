import { Link, useLocation } from "react-router-dom";
import { ImageOff, Loader2, Undo2, X } from "lucide-react";
import { withBackgroundLocation } from "../../lib/backgroundLocation";
import { cn } from "../../lib/cn";
import { hasModifier } from "../../lib/dom";
import { imageHref } from "../../lib/imageFilter";
import type { Output } from "../../lib/generate";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { BATCH } from "../../lib/shortcuts";
import { errorText } from "../../lib/api";
import { useToast } from "../Toasts";
import { ScorePicker } from "../ui/ScoreMark";

/** One output of a batch: the image with its triage (K keep, X reject, 1 to 5 score), or why it isn't there. */
export function ResultTile({ out, ratio, onChanged }: { out: Output; ratio: number; onChanged: () => void }) {
  const location = useLocation();
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.push(errorText(e), "error");
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+1 and Ctrl+X are the browser's.
    if (!out.in_library || hasModifier(e)) return;
    const k = e.key;
    if (BATCH.keep.keys.includes(k)) void act(() => setQuarantine(out.image_id, false));
    else if (BATCH.reject.keys.includes(k)) void act(() => setQuarantine(out.image_id, true));
    // A rejected image is out; it takes a score once restored.
    else if (BATCH.score.keys.includes(k) && !out.quarantined) void act(() => setScore(out.image_id, Number(k)));
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
      <Link to={imageHref(out.image_id)} state={withBackgroundLocation(location)} tabIndex={-1}>
        {out.thumb_url && (
          <img
            src={out.thumb_url}
            alt=""
            loading="lazy"
            className={cn("h-full w-full object-cover transition-[opacity,filter]", rejected && "opacity-40 grayscale")}
          />
        )}
      </Link>
      {/* Rejected is marked like a score: a red grease-pencil X on the print. */}
      {rejected && (
        <span
          aria-label="Rejected"
          title="Rejected"
          className="pointer-events-none absolute left-2 top-1 font-marker text-[30px] leading-none text-red-500 -rotate-6 [text-shadow:0_0_1px_rgb(0_0_0/0.95),0_0_2px_rgb(0_0_0/0.9),0_1px_4px_rgb(0_0_0/0.75)]"
        >
          X
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
