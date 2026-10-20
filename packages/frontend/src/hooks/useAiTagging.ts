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

/** The job each image's own "Tag with AI" started, until the panel sees it
 * end: an image left and opened again picks its job back up at once. */
const jobOfImage = new Map<string, string>();

/**
 * Encapsulates tagging a set of images with AI: queue the job, poll it until a
 * terminal state, toast the outcome, and invoke `onTagged` so the caller can
 * refresh. The caller only calls `start(ids)` and reads `submitting` / `job`.
 *
 * This replaces the bespoke alive-flag/setTimeout/backoff poll loop that lived
 * inside ImageView's TagEditor.
 */
export function useAiTagging(onTagged?: () => void, imageId?: string) {
  const { push } = useToast();
  const qc = useQueryClient();
  // A job picked back up from an earlier visit to this image. If it ended
  // while the panel was closed, it is cleared quietly; if the backend
  // restarted and forgot it, it is dropped.
  const [resumed] = useState<string | null>(() => (imageId && jobOfImage.get(imageId)) || null);
  const [jobId, setJobId] = useState<string | null>(resumed);
  const [submitting, setSubmitting] = useState(false);

  const { data: job, isError } = useQuery({
    queryKey: ["aiJob", jobId],
    queryFn: ({ signal }) => fetchAiJob(jobId!, signal),
    enabled: !!jobId,
    retry: 1,
    refetchInterval: (query) =>
      isTerminalJob(query.state.data?.status) ? false : JOB_POLL_MS,
  });

  const forget = useCallback(
    (id: string) => {
      if (imageId && jobOfImage.get(imageId) === id) jobOfImage.delete(imageId);
    },
    [imageId],
  );

  useEffect(() => {
    if (!jobId || !isError) return;
    forget(jobId);
    setJobId(null);
  }, [jobId, isError, forget]);

  // React to terminal transition: toast, refresh, clear the job.
  const handled = useRef<string | null>(null);
  const sawRunning = useRef<string | null>(null);
  const status = job?.status;
  useEffect(() => {
    if (jobId && status && !isTerminalJob(status)) sawRunning.current = jobId;
  }, [jobId, status]);
  useEffect(() => {
    if (!jobId || !isTerminalJob(status) || handled.current === jobId) return;
    handled.current = jobId;
    forget(jobId);
    if (jobId === resumed && sawRunning.current !== jobId) {
      // Ended while this image was closed: its toast was already due then.
      onTagged?.();
      setJobId(null);
      return;
    }
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
  }, [jobId, status, job?.error, push, onTagged, forget, resumed]);

  const start = useCallback(
    async (ids: string[]) => {
      if (submitting || jobId || !ids.length) return;
      setSubmitting(true);
      try {
        const { job_id } = await postAiTag(ids);
        handled.current = null;
        if (imageId && ids.length === 1 && ids[0] === imageId) jobOfImage.set(imageId, job_id);
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
    [submitting, jobId, push, qc, imageId],
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
