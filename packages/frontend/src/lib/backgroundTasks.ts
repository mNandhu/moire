import { etaLabel, formatDuration } from "./format";

/**
 * Background work as the activity indicator shows it. The server lists what
 * is running (`/api/v1/activity`); this words each item and works out its
 * progress. Pure.
 */

export type TaskKind =
  | "scan"
  | "delete"
  | "reproject"
  | "fold"
  | "model_download"
  | "model_load"
  | "ai_job"
  | "face_download"
  | "faces"
  | "generate";

export type BackgroundTask = {
  key: string;
  kind: TaskKind | string;
  library_id?: string | null;
  done?: number;
  total?: number | null;
  unit?: "bytes";
  /** AI jobs: "model" while the tagger model downloads or loads. */
  phase?: string | null;
  status?: string;
  job_id?: string;
  /** A one-image AI job's image. */
  image_id?: string;
  /** AI jobs: images a second, and seconds left at that rate. */
  rate?: number;
  eta_s?: number;
};

export type TaskView = {
  title: string;
  /** "3 of 10 images", "120 of 340 MB"; null when there's nothing to count. */
  detail: string | null;
  /** 0 to 100, or null while the size of the work is unknown. */
  pct: number | null;
};

const MB = 1024 * 1024;

function count(t: BackgroundTask, noun: string): string | null {
  if (!t.total) return null;
  if (t.unit === "bytes") {
    const mb = (n: number) => Math.round(n / MB).toLocaleString();
    return `${mb(t.done ?? 0)} of ${mb(t.total)} MB`;
  }
  return `${(t.done ?? 0).toLocaleString()} of ${t.total.toLocaleString()} ${noun}`;
}

function withEta(detail: string | null, eta?: number, format: (s: number) => string = formatDuration): string | null {
  if (!detail || eta == null || eta < 1) return detail;
  return `${detail} · ${format(eta)} left`;
}

export function taskPct(t: Pick<BackgroundTask, "done" | "total">): number | null {
  if (!t.total) return null;
  return Math.min(100, Math.max(0, Math.floor(((t.done ?? 0) / t.total) * 100)));
}

/** How one item reads. `libraryName` names a library by id. */
export function describeTask(
  t: BackgroundTask,
  libraryName: (id: string) => string | undefined = () => undefined,
): TaskView {
  const lib = (t.library_id && libraryName(t.library_id)) || "a library";
  const pct = taskPct(t);
  switch (t.kind) {
    case "scan":
      return {
        title: `Scanning ${lib}`,
        detail: count(t, "files") ?? "Waiting to start",
        pct,
      };
    case "delete":
      return { title: `Deleting ${lib}`, detail: null, pct: null };
    case "reproject":
      return {
        title: t.library_id ? `Reading prompts in ${lib}` : "Reading prompts",
        detail: count(t, "images"),
        pct,
      };
    case "fold":
      return { title: `Handing ${lib}'s subfolders to their libraries`, detail: count(t, "images"), pct };
    case "model_download":
      return { title: "Downloading the tagging model", detail: count(t, ""), pct };
    case "model_load":
      return { title: "Loading the tagging model", detail: null, pct: null };
    case "ai_job":
      if (t.phase === "model") return { title: "AI tagging", detail: "Waiting for the model", pct: null };
      if (t.status === "queued") return { title: "AI tagging", detail: "Queued", pct: null };
      return { title: "AI tagging", detail: withEta(count(t, "images"), t.eta_s), pct };
    case "face_download":
      return { title: "Downloading the face model", detail: count(t, ""), pct };
    case "faces":
      return { title: "Centering avatars on faces", detail: count(t, "images"), pct };
    case "generate":
      return {
        title: "Generating",
        // A generation estimate is rounded and said as "about" (lib/eta.ts).
        detail: withEta(t.total ? `${t.total} in the ComfyUI queue` : null, t.eta_s, etaLabel),
        pct: null,
      };
    default:
      return { title: "Working", detail: count(t, "items"), pct };
  }
}

/** How many tasks of each kind have ended since the server started. */
export type EndedCounts = Record<string, number>;

/** The kinds of work that ended between two polls, including work that
 * started and ended between them (never listed as running). A restarted
 * server's counts start over; anything lower than before counts as ended. */
export function endedKinds(before: EndedCounts, after: EndedCounts): Set<string> {
  return new Set(Object.keys(after).filter((k) => after[k] !== (before[k] ?? 0)));
}

/** The kinds of work that just started. */
export function startedKinds(before: readonly BackgroundTask[], after: readonly BackgroundTask[]): Set<string> {
  const was = new Set(before.map((t) => t.key));
  return new Set(after.filter((t) => !was.has(t.key)).map((t) => t.kind));
}
