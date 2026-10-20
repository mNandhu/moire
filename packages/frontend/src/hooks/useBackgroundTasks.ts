import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  endedKinds,
  startedKinds,
  type BackgroundTask,
  type EndedCounts,
} from "../lib/backgroundTasks";
import { AI_COVERAGE_KEY, LIBRARIES_KEY, TAGS_KEY } from "../lib/queries";

export const BACKGROUND_TASKS_KEY = ["activity"] as const;
const BUSY_MS = 1500;
const IDLE_MS = 5000;

type Activity = { items: BackgroundTask[]; ended: EndedCounts };

// Defaults for a reply without them (an older backend).
async function fetchActivity(signal?: AbortSignal): Promise<Activity> {
  const r = await api<Partial<Activity>>("/api/v1/activity", { signal });
  return { items: Array.isArray(r?.items) ? r.items : [], ended: r?.ended ?? {} };
}

function useActivity<T>(select: (a: Activity) => T) {
  return useQuery({
    queryKey: BACKGROUND_TASKS_KEY,
    queryFn: ({ signal }) => fetchActivity(signal),
    refetchInterval: (q) => (q.state.data?.items.length ? BUSY_MS : IDLE_MS),
    staleTime: 0,
    select,
  });
}

const selectItems = (a: Activity) => a.items;
const selectAll = (a: Activity) => a;

/** What the server is doing in the background; fast polls while busy. Any
 * number of readers share the one poll. */
export function useBackgroundTasks() {
  return useActivity(selectItems);
}

/** Work that changes the library list when it starts or ends. */
const LIBRARY_WORK = ["scan", "delete", "fold"];

/**
 * Mounted once (App): when background work ends, the data it changed is
 * refetched wherever it's shown, whichever page started it or is open now.
 */
export function useRefreshOnFinish() {
  const qc = useQueryClient();
  const { data } = useActivity(selectAll);
  const prev = useRef<Activity | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = prev.current;
    prev.current = data;
    if (!before) return;
    const started = startedKinds(before.items, data.items);
    const ended = endedKinds(before.ended, data.ended);
    const any = (kinds: string[]) => kinds.some((k) => started.has(k) || ended.has(k));
    if (any(LIBRARY_WORK)) {
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
