import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GEN_KEY, estimateBatch, type EstimateBody } from "../../lib/generate";
import { estimateNotes, type NewEstimate } from "../../lib/eta";
import { stemOf } from "./RunControls";

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
  return useQuery({
    queryKey: [...GEN_KEY, "estimate", settled],
    queryFn: ({ signal }) => estimateBatch(JSON.parse(settled!) as EstimateBody, signal),
    enabled: !!settled,
    placeholderData: keepPreviousData,
    refetchInterval: busy ? 5000 : false,
  }).data;
}

/**
 * The next batch, drawn as a dashed outline in the output column before it
 * exists: how many images at what shape, and about how long they'd take.
 * Nothing before there are runs to go on.
 */
export function NextBatch({
  estimate,
  generator,
  checkpoint,
  count,
  ratio,
}: {
  estimate: NewEstimate | undefined;
  generator: string;
  checkpoint: string | null;
  count: number;
  ratio: number;
}) {
  const said = estimateNotes(estimate, checkpoint ? stemOf(checkpoint) : null);
  if (!said) return null;
  const tiles = Math.min(count, 4);
  return (
    <section aria-label="Next batch" className="rounded-xl border border-dashed border-line-strong/70 px-3.5 py-3">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-muted">
          Next batch <span className="text-faint">·</span> {generator}
        </span>
        <span className="flex-1" />
        <span className="whitespace-nowrap tabular-nums text-neutral-100" title={said.basis ?? undefined}>
          {said.time}
        </span>
      </div>
      <div className="mt-2.5 flex items-end gap-1.5" aria-hidden>
        {Array.from({ length: tiles }, (_, i) => (
          <div key={i} className="h-14 rounded-md border border-dashed border-line" style={{ aspectRatio: ratio }} />
        ))}
        {count > tiles && <span className="pb-1 text-xs tabular-nums text-faint">+{count - tiles}</span>}
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
