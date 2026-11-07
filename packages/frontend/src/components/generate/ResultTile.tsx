import { useContext, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UndoActionContext } from "../../lib/undoActions";
import { GEN_KEY, invalidateQueue, type Output } from "../../lib/generate";
import { Link, useLocation } from "react-router-dom";
import { ImageOff, Loader2, Undo2, X } from "lucide-react";
import { withBackgroundLocation } from "../../lib/backgroundLocation";
import { cn } from "../../lib/cn";
import { hasModifier } from "../../lib/dom";
import { imageHref } from "../../lib/imageFilter";
import { StepListContext, stepsState } from "../../lib/stepList";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { BATCH } from "../../lib/shortcuts";
import { errorText } from "../../lib/api";
import { useToast } from "../Toasts";
import { ScorePicker } from "../ui/ScoreMark";

/** One output of a batch: the image with its triage (K keep, X reject, 1 to 5 score), or why it isn't there. */
export function ResultTile({ out, ratio, onChanged }: { out: Output; ratio: number; onChanged: () => void }) {
  const location = useLocation();
  const steps = useContext(StepListContext);
  const toast = useToast();
  const qc = useQueryClient();
  const pushUndo = useContext(UndoActionContext);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      toast.push(errorText(e), "error");
      return false;
    }
  };
  // Undo and redo run after the tile may be gone (cleared from the
  // column), so they refresh every batch themselves.
  const replay = async (id: string, on: boolean) => {
    try {
      await setQuarantine(id, on);
    } catch (e) {
      toast.push(errorText(e), "error");
    }
    invalidateQueue(qc);
    void qc.invalidateQueries({ queryKey: [...GEN_KEY, "batch"] });
  };
  // One change at a time: a second X before the first lands is not a step.
  const busy = useRef(false);
  /** Reject (or keep) the image, a step of the page's Ctrl+Z; nothing when
   * it is that already. */
  const setRejected = async (on: boolean) => {
    if (busy.current || !!out.quarantined === on) return;
    busy.current = true;
    const id = out.image_id;
    try {
      if (await act(() => setQuarantine(id, on))) pushUndo?.({ undo: () => replay(id, !on), redo: () => replay(id, on) });
    } finally {
      busy.current = false;
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+1 and Ctrl+X are the browser's.
    if (!out.in_library || hasModifier(e)) return;
    const k = e.key;
    if (BATCH.keep.keys.includes(k)) void setRejected(false);
    else if (BATCH.reject.keys.includes(k)) void setRejected(true);
    // A rejected image is out; it takes a score once restored.
    else if (BATCH.score.keys.includes(k) && !out.quarantined) void act(() => setScore(out.image_id, Number(k)));
  };
  if (!out.in_library) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint"
        style={{ aspectRatio: ratio }}
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
      aria-keyshortcuts={rejected ? "K" : "K X 1 2 3 4 5"}
      className="group relative overflow-hidden rounded-lg bg-raised outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      style={{ aspectRatio: ratio }}
    >
      <Link
        to={imageHref(out.image_id)}
        state={steps ? { ...withBackgroundLocation(location), ...stepsState(steps) } : withBackgroundLocation(location)}
        tabIndex={-1}
      >
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
            onClick={() => void setRejected(false)}
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
              onClick={() => void setRejected(true)}
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
