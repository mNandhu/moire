// AI tagging domain: the Tagger/Model lifecycle, AI Jobs, and AI Settings as
// the frontend sees them. Status predicates are pure (the test surface); the
// polling cadence that used to be hand-rolled in three places now derives from
// them. See CONTEXT.md › AI Job, Tagger / Model, AI Settings.
import { api } from "./api";


export type AISettings = {
  model_repo: string;
  general_thresh: number;
  character_thresh: number;
  general_mcut: boolean;
  character_mcut: boolean;
  max_general: number;
  max_character: number;
  idle_unload_s: number;
  cache_dir: string;
  prompt_positive_only: boolean;
};

/** A single failure recorded while an AI Job processed one image. */
export type AiJobError = { image_id: string; error: string };

export type AiJob = {
  id: string;
  created_at: number;
  status: string;
  total: number;
  done: number;
  failed: number;
  skipped?: number;
  current?: string | null;
  errors?: AiJobError[];
};

export type AIStatus = {
  model: {
    loaded: boolean;
    repo?: string | null;
    last_used?: number;
    idle_unload_s?: number;
  };
  model_load?: {
    status: string;
    error?: string | null;
    loading_for?: [string, string] | null;
    available?: boolean;
  };
  model_download?: {
    status: string;
    cancel_requested?: boolean;
    error?: string | null;
    files?: Array<{
      name: string;
      status: string;
      downloaded: number;
      total?: number | null;
      error?: string | null;
    }>;
  };
  jobs: { recent: AiJob[]; queue_depth: number };
  settings: AISettings;
};

export type AiLibraryCoverage = {
  library_id: string;
  total: number;
  ai_tagged: number;
};

/** AI-tag coverage across the collection (and per library). */
export type AiCoverage = {
  total: number;
  ai_tagged: number;
  /** Not AI-tagged (may still carry manual or prompt tags). */
  untagged: number;
  /** No tags of any kind. Absent from older backends. */
  no_tags?: number;
  per_library: AiLibraryCoverage[];
};

const TERMINAL = new Set(["done", "error", "cancelled"]);
const ACTIVE = new Set(["queued", "running", "cancelling"]);

/** An AI Job in a terminal state no longer needs polling. */
export function isTerminalJob(status: string | undefined | null): boolean {
  return !!status && TERMINAL.has(status);
}

/** An AI Job still doing work (poll faster, allow cancel). */
export function isActiveJob(status: string | undefined | null): boolean {
  return !!status && ACTIVE.has(status);
}

/**
 * Whether the AI subsystem is doing anything that warrants a faster poll:
 * a model loading/downloading, or any recent job still active.
 */
export function isStatusBusy(s: AIStatus | undefined | null): boolean {
  if (!s) return false;
  return (
    s.model_load?.status === "loading" ||
    s.model_download?.status === "downloading" ||
    (s.jobs?.recent ?? []).some((j) => isActiveJob(j.status))
  );
}

// --- Reads ------------------------------------------------------------------

export function fetchAiStatus(signal?: AbortSignal): Promise<AIStatus> {
  return api<AIStatus>("/api/v1/ai/status", { signal });
}

export function fetchAiJob(id: string, signal?: AbortSignal): Promise<AiJob> {
  return api<AiJob>(`/api/v1/ai/jobs/${encodeURIComponent(id)}`, { signal });
}

/**
 * "just now" / "5 min ago" / "3 h ago" / "2 days ago" for a job's
 * `created_at` (epoch seconds). `now` is injectable for tests.
 */
export function jobAgo(createdAtS: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - createdAtS));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** Human status for a job row. */
export function jobStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Running";
    case "cancelling":
      return "Cancelling";
    case "done":
      return "Done";
    case "error":
      return "Finished with errors";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

export function fetchAiCoverage(signal?: AbortSignal): Promise<AiCoverage> {
  return api<AiCoverage>("/api/v1/ai/coverage", { signal });
}

export function fetchAiSettings(): Promise<AISettings> {
  return api<AISettings>("/api/v1/ai/settings");
}

// --- Commands ---------------------------------------------------------------
//
// Every AI mutation the UI can issue. These used to live inside SettingsContext,
// fused to toast + busy-flag state, which meant six endpoints existed in exactly
// one React hook and `/jobs/:id/cancel` had two adapters that disagreed on whose
// job it was. The context now owns state and toast policy; it knows no URLs.

const POST = { method: "POST" } as const;

function postJson<T>(url: string, body: unknown): Promise<T> {
  return api<T>(url, {
    ...POST,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Queue an AI tagging job for the given image ids; returns the job id. */
export function postAiTag(ids: string[]): Promise<{ job_id: string }> {
  return postJson<{ job_id: string }>("/api/v1/ai/tag", { ids });
}

/** Request cancellation of an AI tagging job. Returns whether the backend
 * accepted the request (false if the job already finished). */
export function postAiJobCancel(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(
    `/api/v1/ai/jobs/${encodeURIComponent(id)}/cancel`,
    POST
  );
}

export function saveAiSettings(settings: AISettings): Promise<AISettings> {
  return postJson<AISettings>("/api/v1/ai/settings", settings);
}

export function postModelLoad(): Promise<{ started: boolean }> {
  return api<{ started: boolean }>("/api/v1/ai/model/load", POST);
}

export function postModelLoadCancel(): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>("/api/v1/ai/model/load-cancel", POST);
}

export function postModelDownloadCancel(): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>("/api/v1/ai/model/download-cancel", POST);
}

export function postModelUnload(): Promise<unknown> {
  return api("/api/v1/ai/model/unload", POST);
}

/** Queue AI tagging for up to `limit` images that have no AI tags yet. */
export function postTagUntagged(
  limit: number
): Promise<{ job_id: string | null; queued: number }> {
  return postJson<{ job_id: string | null; queued: number }>(
    "/api/v1/ai/tag-untagged",
    { limit }
  );
}

/** Remove AI tags + AI metadata from every image (manual tags are kept). */
export function postClearAiTags(): Promise<{
  matched: number;
  modified: number;
}> {
  return api<{ matched: number; modified: number }>(
    "/api/v1/ai/clear-ai-tags",
    POST
  );
}
