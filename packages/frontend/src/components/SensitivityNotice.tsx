import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { errorText } from "../lib/api";
import { postTagUntagged } from "../lib/ai";
import { unknownAiJob, describeTask } from "../lib/backgroundTasks";
import { useSensitivity } from "../lib/queries/sensitivity";
import { unknownHidden } from "../lib/sensitivity";
import { BACKGROUND_TASKS_KEY, useBackgroundTasks, useCancelAiJob } from "../hooks/useBackgroundTasks";
import { useToast } from "./Toasts";
import { Button, ProgressBar } from "./ui";

const DISMISSED = "moire.sensitivity.unknown-dismissed";

/** While the sensitivity filter is on: how many images it hides for having
 * no level yet, and the AI tagging that gives them one. While that tagging
 * runs it shows its progress (and Cancel) in place of the button, and
 * the count follows the job. `dismissible` (the gallery) hides it for the
 * rest of the session. */
export function UnknownHiddenNotice({ dismissible = false }: { dismissible?: boolean }) {
  const { data: tasks } = useBackgroundTasks();
  const job = unknownAiJob(tasks);
  const { data } = useSensitivity({ poll: !!job });
  const qc = useQueryClient();
  const { push } = useToast();
  const { cancel, cancelling } = useCancelAiJob();
  const [queueing, setQueueing] = useState(false);
  const [dismissed, setDismissed] = useState(() => dismissible && sessionStorage.getItem(DISMISSED) === "1");
  const unknown = unknownHidden(data);
  if (!unknown || dismissed) return null;

  const tag = async () => {
    setQueueing(true);
    try {
      const r = await postTagUntagged(unknown, undefined, { unknown: true });
      push(
        r.queued
          ? `Queued AI tagging for ${r.queued.toLocaleString()} images`
          : r.skipped
            ? "Already being tagged"
            : "Nothing left to tag",
        r.queued ? "success" : "info",
      );
      // The progress replaces the button now, not at the next idle poll (a
      // job already tagging them takes the banner too).
      void qc.invalidateQueries({ queryKey: BACKGROUND_TASKS_KEY });
    } catch (e) {
      push(`Couldn't start AI tagging: ${errorText(e)}`, "error");
    } finally {
      setQueueing(false);
    }
  };

  const view = job ? describeTask(job) : null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-800/60 bg-amber-900/20 px-3 py-2 text-sm text-amber-100"
    >
      <span className="min-w-0 flex-1">{unknown.toLocaleString()} images hidden until AI-tagged</span>
      {job && view ? (
        // Phones: its own full-width row under the count (and the dismiss).
        <div className="order-last flex w-full min-w-0 items-center gap-3 sm:order-none sm:w-auto">
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
            <div className="truncate text-xs tabular-nums text-amber-100/80">{view.detail ?? "Tagging"}</div>
            <ProgressBar
              value={view.pct ?? 0}
              className="mt-1 h-1"
              aria-label="AI tagging progress"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            pending={cancelling === job.job_id}
            onClick={() => void cancel(job.job_id!)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button size="sm" pending={queueing} onClick={() => void tag()}>
          Tag them
        </Button>
      )}
      {dismissible && (
        <Button
          size="iconSm"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => {
            sessionStorage.setItem(DISMISSED, "1");
            setDismissed(true);
          }}
        >
          <X size={14} />
        </Button>
      )}
    </div>
  );
}
