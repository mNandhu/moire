import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GEN_KEY, estimateBatch, type EstimateBody } from "../../lib/generate";
import { estimateNotes, type NewEstimate } from "../../lib/eta";
import { stemOf } from "./RunControls";
import { ShapeIcon } from "../SizeFilter";

/**
 * How long the batch on the form would take if queued now. The form is read
 * a moment after it stops changing; while other work runs, the time ahead of
 * it is read again every few seconds.
 */
export function useNextEstimate(body: EstimateBody | null, { busy }: { busy: boolean }) {
  const json = body ? JSON.stringify(body) : null;
  const [settled, setSettled] = useState(json);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(json), 400);
    return () => clearTimeout(timer);
  }, [json]);
  const { data } = useQuery({
    queryKey: [...GEN_KEY, "estimate", settled],
    queryFn: ({ signal }) => estimateBatch(JSON.parse(settled!) as EstimateBody, signal),
    enabled: !!settled,
    // The last number stays while an edit settles, not once there's no
    // batch to estimate (ComfyUI down, the Generator not tested).
    placeholderData: keepPreviousData,
    refetchInterval: busy ? 5000 : false,
  });
  return json && settled ? data : undefined;
}

/**
 * What Generate would make from the form as it stands, drawn as a dashed
 * outline in the output column before it exists: how many images at what
 * size, and about how long they'd take. Not the queue: it shows with nothing
 * queued. Nothing before there are runs to go on.
 */
export function NextBatch({
  estimate,
  generator,
  checkpoint,
  count,
  width,
  height,
}: {
  estimate: NewEstimate | undefined;
  generator: string;
  checkpoint: string | null;
  /** With its unit: "3 images", or "3 runs". */
  count: string;
  width: number;
  height: number;
}) {
  const said = estimateNotes(estimate, checkpoint ? stemOf(checkpoint) : null);
  if (!said) return null;
  return (
    <section aria-label="If you generate now" className="rounded-xl border border-dashed border-line-strong/70 px-3.5 py-3">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-muted">
          If you generate now <span className="text-faint">·</span> {generator}
        </span>
        <span className="flex-1" />
        <span className="whitespace-nowrap tabular-nums text-neutral-100" title={said.basis ?? undefined}>
          {said.time}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
        <ShapeIcon width={width} height={height} size={12} />
        <span className="tabular-nums">
          {count} · {width}×{height}
        </span>
      </div>
      {said.notes.length > 0 && (
        <div className="mt-2 space-y-0.5 text-xs text-faint">
          {said.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
        </div>
      )}
    </section>
  );
}
