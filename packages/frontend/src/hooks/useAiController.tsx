import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "../components/Toasts";
import { useConfirm } from "../components/ConfirmDialog";
import { useAiStatus } from "./useAiStatus";
import { useQueryClient } from "@tanstack/react-query";
import type { AIStatus, AiJob } from "../lib/ai";
import {
  AI_STATUS_KEY,
  postAiSettingsPatch,
  cancelJobMessage,
  postAiJobCancel,
  postClearAiTags,
  postModelDownloadCancel,
  postModelLoad,
  postModelLoadCancel,
  postModelUnload,
  postTagUntagged,
} from "../lib/ai";
import { errorText } from "../lib/api";

type LatestJob = AiJob | null;

/**
 * The AI tagging controller: polled status plus the job and model commands,
 * sharing one busy flag and toast policy. Mounted by the AI Tagging page and
 * the Settings model card; the editable settings form is a separate hook
 * (`useAiSettingsForm`).
 */
export type AiController = {
  status: AIStatus | undefined;
  running: boolean;
  isModelLoaded: boolean;
  isModelLoading: boolean;
  latestJob: LatestJob;
  progressPct: number;
  /** Auto-tag is on: new images are tagged as they arrive. */
  autoTag: boolean;
  setAutoTag: (on: boolean) => Promise<void>;
  loadModel: () => Promise<void>;
  cancelModelLoad: () => Promise<void>;
  cancelModelDownload: () => Promise<void>;
  unloadModel: () => Promise<void>;
  /** Tag the images without AI tags, in one library or all: every one, or
   * the newest `limit`. */
  runUntagged: (libraryId?: string, limit?: number | null) => Promise<void>;
  clearAllAiTags: () => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
};

function useAiControllerState(): AiController {
  const { push } = useToast();
  const confirm = useConfirm();
  const [running, setRunning] = useState(false);
  const qc = useQueryClient();

  // AI status is a shared polled query; cadence derives from isStatusBusy.
  const { data: status } = useAiStatus();

  const isModelLoaded = Boolean(status?.model?.loaded);
  const isModelLoading = status?.model_load?.status === "loading";

  // The job being worked on, else the newest: a job queued behind the
  // running one mustn't take its place on the page.
  const latestJob = useMemo(() => {
    const recent = status?.jobs?.recent ?? [];
    return recent.find((j) => j.status === "running" || j.status === "cancelling") ?? recent[0] ?? null;
  }, [status]);

  const progressPct = useMemo(() => {
    if (!latestJob || !latestJob.total) return 0;
    return Math.min(
      100,
      Math.round(((latestJob.done + latestJob.failed) / latestJob.total) * 100)
    );
  }, [latestJob]);

  /** Run one AI command with the shared busy flag + toast policy. `report`
   * turns the result into a message; throwing is reported via `failure`. */
  const runCommand = async <T,>(
    action: () => Promise<T>,
    report: (result: T) => [string, "success" | "error" | "info"] | null,
    failure: string
  ) => {
    setRunning(true);
    try {
      const said = report(await action());
      if (said) push(said[0], said[1]);
    } catch (e) {
      push(`${failure}: ${errorText(e)}`, "error");
    } finally {
      setRunning(false);
    }
  };

  const cancelJob = (jobId: string) =>
    runCommand(
      () => postAiJobCancel(jobId),
      (r) => cancelJobMessage(r.ok),
      "Failed to cancel"
    );

  const loadModel = () =>
    runCommand(
      postModelLoad,
      (r) => [
        r.started ? "Model load started" : "Model already loading/loaded",
        "info",
      ],
      "Failed to load model"
    );

  const cancelModelLoad = () =>
    runCommand(
      postModelLoadCancel,
      (r) => [
        r.ok ? "Cancelled model load" : "Nothing to cancel",
        r.ok ? "success" : "info",
      ],
      "Failed to cancel load"
    );

  const cancelModelDownload = () =>
    runCommand(
      postModelDownloadCancel,
      (r) => [
        r.ok ? "Cancelled download" : "Nothing to cancel",
        r.ok ? "success" : "info",
      ],
      "Failed to cancel download"
    );

  const unloadModel = () =>
    runCommand(
      postModelUnload,
      () => ["Model unloaded", "success"],
      "Failed to unload model"
    );

  const runUntagged = (libraryId?: string, limit: number | null = null) =>
    runCommand(
      () => postTagUntagged(limit, libraryId),
      (r) =>
        r.queued
          ? [`Queued AI tagging for ${r.queued.toLocaleString()} images`, "success"]
          : ["No images are missing AI tags", "info"],
      "Failed to start job"
    );

  const autoTag = Boolean(status?.settings?.auto_tag);
  const setAutoTag = (on: boolean) =>
    runCommand(
      async () => {
        const saved = await postAiSettingsPatch({ auto_tag: on });
        qc.setQueryData<AIStatus | undefined>(AI_STATUS_KEY, (d) => (d ? { ...d, settings: saved } : d));
        void qc.invalidateQueries({ queryKey: AI_STATUS_KEY });
      },
      () => null,
      "Failed to change auto-tag"
    );

  const clearAllAiTags = async () => {
    const ok = await confirm({
      title: "Clear all AI tags?",
      message:
        "This removes all AI-generated tags and AI metadata from every image in every library. Manual tags (manual:) are kept.",
      confirmLabel: "Clear AI tags",
      tone: "danger",
    });
    if (!ok) return;
    await runCommand(
      postClearAiTags,
      (r) => [`Cleared AI tags on ${r.modified} images`, "success"],
      "Failed to clear AI tags"
    );
  };

  return {
    status,
    running,
    isModelLoaded,
    isModelLoading,
    latestJob,
    progressPct,
    autoTag,
    setAutoTag,
    loadModel,
    cancelModelLoad,
    cancelModelDownload,
    unloadModel,
    runUntagged,
    clearAllAiTags,
    cancelJob,
  };
}

const Ctx = createContext<AiController | null>(null);

export function AiControllerProvider({ children }: { children: ReactNode }) {
  const controller = useAiControllerState();
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

export function useAiController(): AiController {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAiController must be used within <AiControllerProvider>");
  return v;
}
