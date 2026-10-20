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
  /** A small AI job's images. */
  image_ids?: string[];
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
      return { title: "AI tagging", detail: count(t, "images"), pct };
    case "face_download":
      return { title: "Downloading the face model", detail: count(t, ""), pct };
    case "faces":
      return { title: "Centering avatars on faces", detail: count(t, "images"), pct };
    case "generate":
      return {
        title: "Generating",
        detail: t.total ? `${t.total} in the ComfyUI queue` : null,
        pct: null,
      };
    default:
      return { title: "Working", detail: count(t, "items"), pct };
  }
}

/** The kinds whose end changes what's on screen, by what they change. */
export function finishedKinds(before: readonly BackgroundTask[], after: readonly BackgroundTask[]): Set<string> {
  const still = new Set(after.map((t) => t.key));
  return new Set(before.filter((t) => !still.has(t.key)).map((t) => t.kind));
}
