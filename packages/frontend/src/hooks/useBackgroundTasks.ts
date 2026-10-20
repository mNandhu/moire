import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { finishedKinds, type BackgroundTask } from "../lib/backgroundTasks";
import { AI_COVERAGE_KEY, LIBRARIES_KEY, TAGS_KEY } from "../lib/queries";

export const BACKGROUND_TASKS_KEY = ["activity"] as const;
const BUSY_MS = 1500;
const IDLE_MS = 5000;

function fetchBackgroundTasks(signal?: AbortSignal) {
  return api<{ items: BackgroundTask[] }>("/api/v1/activity", { signal }).then((r) => r.items);
}

/** What the server is doing in the background; fast polls while busy. Any
 * number of readers share the one poll. */
export function useBackgroundTasks() {
  return useQuery({
    queryKey: BACKGROUND_TASKS_KEY,
    queryFn: ({ signal }) => fetchBackgroundTasks(signal),
    refetchInterval: (q) => (q.state.data?.length ? BUSY_MS : IDLE_MS),
    staleTime: 0,
  });
}

/**
 * Mounted once (App): when background work ends, the data it changed is
 * refetched wherever it's shown, whichever page started it or is open now.
 */
export function useRefreshOnFinish() {
  const qc = useQueryClient();
  const { data } = useBackgroundTasks();
  const prev = useRef<BackgroundTask[] | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = prev.current;
    prev.current = data;
    if (!before) return;
    const started = data.some((t) => !before.some((b) => b.key === t.key));
    const ended = finishedKinds(before, data);
    if (started || ended.has("scan") || ended.has("delete") || ended.has("fold")) {
      void qc.invalidateQueries({ queryKey: LIBRARIES_KEY });
    }
    if (ended.has("ai_job")) {
      // The open image's doc (ImageView) and every cached one: their tags changed.
      void qc.invalidateQueries({ queryKey: ["image"] });
      void qc.invalidateQueries({ queryKey: AI_COVERAGE_KEY });
      void qc.invalidateQueries({ queryKey: ["aiStatus"] });
    }
    if (["ai_job", "scan", "delete", "reproject", "fold", "faces"].some((k) => ended.has(k))) {
      void qc.invalidateQueries({ queryKey: TAGS_KEY });
    }
  }, [data, qc]);
}
