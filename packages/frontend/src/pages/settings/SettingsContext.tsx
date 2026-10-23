import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "../../components/Toasts";
import { useConfirm } from "../../components/ConfirmDialog";
import { useAiStatus } from "../../hooks/useAiStatus";
import type { AISettings, AIStatus, AiJob } from "../../lib/ai";
import {
  fetchAiSettings,
  postAiJobCancel,
  postClearAiTags,
  postModelDownloadCancel,
  postModelLoad,
  postModelLoadCancel,
  postModelUnload,
  postTagUntagged,
  saveAiSettings,
} from "../../lib/ai";
import { errorText } from "../../lib/api";

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

type LatestJob = AiJob | null;

/**
 * All AI settings state + actions shared across settings sections.
 * Lives once so sections (Model, Tagging, Prompt tags, Jobs) read/write the
 * same `settings`/`status` without prop-threading. Independent future sections
 * (e.g. Appearance) are free to own local state and ignore this context.
 */
export type SettingsController = {
  settings: AISettings | null;
  setSettings: React.Dispatch<React.SetStateAction<AISettings | null>>;
  status: AIStatus | undefined;
  saving: boolean;
  running: boolean;
  isModelLoaded: boolean;
  isModelLoading: boolean;
  latestJob: LatestJob;
  progressPct: number;
  untaggedLimit: number;
  setUntaggedLimit: (n: number) => void;
  save: () => Promise<void>;
  loadModel: () => Promise<void>;
  cancelModelLoad: () => Promise<void>;
  cancelModelDownload: () => Promise<void>;
  unloadModel: () => Promise<void>;
  /** Tag up to `untaggedLimit` images without AI tags, in one library or all. */
  runUntagged: (libraryId?: string) => Promise<void>;
  clearAllAiTags: () => Promise<void>;
  cancelJob: (jobId: string) => Promise<void>;
};

function useSettingsController(): SettingsController {
  const { push } = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [untaggedLimit, setUntaggedLimit] = useState(200);

  // AI status is a shared polled query; cadence derives from isStatusBusy.
  const { data: status } = useAiStatus();

  const isModelLoaded = Boolean(status?.model?.loaded);
  const isModelLoading = status?.model_load?.status === "loading";

  // Initial load
  useEffect(() => {
    fetchAiSettings()
      .then(setSettings)
      .catch((e) => push(`Failed to load AI settings: ${errorText(e)}`, "error"));
  }, [push]);

  // Seed the editable form from polled status until the user's copy loads.
  useEffect(() => {
    if (status?.settings) setSettings((prev) => prev ?? status.settings);
  }, [status?.settings]);

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
      (r) => [
        r.ok ? "Cancellation requested" : "Could not cancel job",
        r.ok ? "success" : "error",
      ],
      "Failed to cancel"
    );

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(await saveAiSettings(settings));
      push("Saved AI settings", "success");
    } catch (e) {
      push(`Failed to save: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

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

  const runUntagged = (libraryId?: string) =>
    runCommand(
      () => postTagUntagged(untaggedLimit, libraryId),
      (r) =>
        r.queued
          ? [`Queued AI tagging for ${r.queued} images`, "success"]
          : ["No images are missing AI tags", "info"],
      "Failed to start job"
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
    settings,
    setSettings,
    status,
    saving,
    running,
    isModelLoaded,
    isModelLoading,
    latestJob,
    progressPct,
    untaggedLimit,
    setUntaggedLimit,
    save,
    loadModel,
    cancelModelLoad,
    cancelModelDownload,
    unloadModel,
    runUntagged,
    clearAllAiTags,
    cancelJob,
  };
}

const Ctx = createContext<SettingsController | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const controller = useSettingsController();
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsController {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSettings must be used within <SettingsProvider>");
  return v;
}
