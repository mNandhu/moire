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
  /** Crop character avatars to the face, once the face model is downloaded. */
  face_detect: boolean;
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
  /** "model" while the tagger model downloads or loads, then "tagging". */
  phase?: string | null;
  /** Why the whole job failed (the model wouldn't load). */
  error?: string | null;
  errors?: AiJobError[];
  /** Images a second since the first image; absent until one is through. */
  rate?: number;
  /** Seconds spent tagging (until now, or until the job ended). */
  elapsed_s?: number;
  /** Seconds left at the current rate; running jobs only. */
  eta_s?: number;
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
 * Whole-number percent of `part` in `whole` for coverage readouts. Rounds
 * down, and only a complete set reads 100%: plain rounding showed
 * "100% · 4 to go" at 9,996 of 10,000. Any progress at all reads at least 1%.
 */
export function coveragePct(part: number, whole: number): number {
  if (!whole || part <= 0) return 0;
  if (part >= whole) return 100;
  return Math.min(99, Math.max(1, Math.floor((part / whole) * 100)));
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

/** What the "Run AI tagging" button says while its job runs; null when
 * there's no job. The model's own download and load show beside it. */
export function aiJobLabel(job: Pick<AiJob, "status" | "phase"> | null | undefined): string | null {
  if (!job) return null;
  if (job.status === "cancelling") return "Cancelling…";
  if (job.status === "queued") return "Queued…";
  if (job.phase === "model") return "Waiting for model…";
  return "Tagging…";
}

/** "45 s", "3 min", "1 h 5 min". */
export function formatDuration(s: number): string {
  const sec = Math.max(0, Math.round(s));
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** "3.2 images/s", or per minute when slower than one a second. */
export function formatRate(rate: number): string {
  if (rate >= 1) return `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} images/s`;
  const perMin = Math.round(rate * 60);
  if (perMin < 1) return "under 1 image/min";
  return `${perMin} ${perMin === 1 ? "image" : "images"}/min`;
}

/** An image id's file name: the id is `{library_id}:{relative/path}`, and
 * the path itself may hold colons. */
export function imageFileName(imageId: string): string {
  const path = imageId.slice(imageId.indexOf(":") + 1);
  return path.split(/[\\/]/).pop() || path;
}

/** A job's speed for a progress line: "3.2 images/s · 2 min left" while
 * running, "3.2 images/s · 4 min" once ended; null before it's measurable. */
export function jobThroughput(job: Pick<AiJob, "rate" | "eta_s" | "elapsed_s">): string | null {
  if (job.rate == null) return null;
  const parts = [formatRate(job.rate)];
  if (job.eta_s != null) parts.push(job.eta_s < 1 ? "almost done" : `${formatDuration(job.eta_s)} left`);
  else if (job.elapsed_s != null) parts.push(formatDuration(job.elapsed_s));
  return parts.join(" · ");
}

export type LibraryCoverageRow = AiLibraryCoverage & { name: string; untagged: number; pct: number };

/** Per-library coverage for the AI Tagging page: the libraries with work
 * left, most untagged first, and those already fully tagged. */
export function libraryCoverageRows(
  perLibrary: readonly AiLibraryCoverage[],
  nameOf: (id: string) => string,
): { todo: LibraryCoverageRow[]; done: LibraryCoverageRow[] } {
  const rows = perLibrary.map((l) => ({
    ...l,
    name: nameOf(l.library_id),
    untagged: Math.max(0, l.total - l.ai_tagged),
    pct: coveragePct(l.ai_tagged, l.total),
  }));
  const byName = (a: LibraryCoverageRow, b: LibraryCoverageRow) => a.name.localeCompare(b.name);
  return {
    todo: rows.filter((r) => r.untagged > 0).sort((a, b) => b.untagged - a.untagged || byName(a, b)),
    done: rows.filter((r) => r.untagged === 0).sort(byName),
  };
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
  limit: number,
  libraryId?: string
): Promise<{ job_id: string | null; queued: number }> {
  return postJson<{ job_id: string | null; queued: number }>(
    "/api/v1/ai/tag-untagged",
    libraryId ? { limit, library_id: libraryId } : { limit }
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
