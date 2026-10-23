import { useQuery } from "@tanstack/react-query";
import { AI_STATUS_KEY, fetchAiStatus, isStatusBusy } from "../lib/ai";

const BUSY_INTERVAL_MS = 2000;
const IDLE_INTERVAL_MS = 5000;

/**
 * Poll `/api/v1/ai/status`. Cadence derives from the pure isStatusBusy predicate:
 * fast while the model/jobs are working, slow when idle. Replaces the
 * hand-rolled setTimeout/backoff loop that lived in SettingsPage.
 */
export function useAiStatus() {
  return useQuery({
    queryKey: AI_STATUS_KEY,
    queryFn: ({ signal }) => fetchAiStatus(signal),
    refetchInterval: (query) =>
      isStatusBusy(query.state.data) ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS,
    staleTime: 0,
  });
}
