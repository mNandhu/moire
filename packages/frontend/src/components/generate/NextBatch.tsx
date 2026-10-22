import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GEN_KEY, estimateBatch, type EstimateBody } from "../../lib/generate";

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
