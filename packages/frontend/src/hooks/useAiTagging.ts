import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BACKGROUND_TASKS_KEY } from "./useBackgroundTasks";
import { useToast } from "../components/Toasts";
import {
  fetchAiJob,
  isActiveJob,
  isTerminalJob,
  postAiJobCancel,
  postAiTag,
} from "../lib/ai";

const JOB_POLL_MS = 1500;

/**
 * Encapsulates tagging a set of images with AI: queue the job, poll it until a
 * terminal state, toast the outcome, and invoke `onTagged` so the caller can
 * refresh. The caller only calls `start(ids)` and reads `submitting` / `job`.
 *
 * This replaces the bespoke alive-flag/setTimeout/backoff poll loop that lived
 * inside ImageView's TagEditor.
 */
export function useAiTagging(onTagged?: () => void) {
  const { push } = useToast();
  const qc = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: job } = useQuery({
    queryKey: ["aiJob", jobId],
    queryFn: ({ signal }) => fetchAiJob(jobId!, signal),
    enabled: !!jobId,
    refetchInterval: (query) =>
      isTerminalJob(query.state.data?.status) ? false : JOB_POLL_MS,
  });

  // React to terminal transition: toast, refresh, clear the job.
  const handled = useRef<string | null>(null);
  const status = job?.status;
  useEffect(() => {
    if (!jobId || !isTerminalJob(status) || handled.current === jobId) return;
    handled.current = jobId;
    if (status === "done") {
      push("AI tagging completed", "success");
      onTagged?.();
    } else if (status === "error") {
      push(job?.error ? `AI tagging failed: ${job.error}` : "AI tagging finished with errors", "error");
      onTagged?.();
    } else if (status === "cancelled") {
      push("AI tagging was cancelled", "info");
    }
    setJobId(null);
  }, [jobId, status, job?.error, push, onTagged]);

  const start = useCallback(
    async (ids: string[]) => {
      if (submitting || jobId || !ids.length) return;
      setSubmitting(true);
      try {
        const { job_id } = await postAiTag(ids);
        handled.current = null;
        // No toast: the button shows the job's progress. Its model download
        // shows through the background-work poll, asked now, not in 5s.
        setJobId(job_id);
        void qc.invalidateQueries({ queryKey: BACKGROUND_TASKS_KEY });
      } catch (e) {
        push(`Failed to start AI tagging: ${String(e)}`, "error");
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, jobId, push, qc],
  );

  /** Follow a job started elsewhere (this image's panel, opened again). */
  const adopt = useCallback(
    (id: string) => {
      // Not one it already saw finish: the activity list can lag behind it.
      if (jobId || submitting || handled.current === id) return;
      setJobId(id);
    },
    [jobId, submitting],
  );

  const [cancelling, setCancelling] = useState(false);
  const cancel = useCallback(async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    try {
      const { ok } = await postAiJobCancel(jobId);
      push(
        ok ? "Cancellation requested" : "Job already finished",
        ok ? "info" : "info",
      );
    } catch (e) {
      push(`Failed to cancel: ${String(e)}`, "error");
    } finally {
      setCancelling(false);
    }
  }, [jobId, cancelling, push]);

  return {
    start,
    adopt,
    cancel,
    submitting,
    cancelling,
    jobId,
    job: job ?? null,
    canCancel: !!jobId && isActiveJob(status),
  };
}
