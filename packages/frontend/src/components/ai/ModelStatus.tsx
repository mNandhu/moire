import { Link } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/ProgressBar";
import { taskPct } from "../../lib/backgroundTasks";
import { formatBytes } from "../../lib/format";
import { useAiController } from "../../hooks/useAiController";

/**
 * The tagger model loads on demand (a job's first image waits for it) and
 * unloads after `idle_unload_s` idle, so its residency is plumbing. The UI
 * only speaks up when that plumbing affects the user: a first-run download,
 * a load in progress, or a failure to retry. Manual preload/unload is an
 * advanced control and lives in Settings (`ModelSection`).
 */

function shortRepo(repo?: string | null) {
  return repo ? repo.split("/").pop() : "the tagger model";
}

/**
 * Whether the last download still matters. A running one always does; a
 * failed or cancelled one only until the model is loaded (e.g. from cache
 * later), or a stale "Download cancelled" would mask the model being ready.
 */
function downloadRelevant(dlStatus: string | undefined, loaded: boolean): boolean {
  if (dlStatus === "downloading") return true;
  return !loaded && (dlStatus === "error" || dlStatus === "cancelled");
}

/** Per-file download progress, shown only while a download is relevant. */
export function DownloadProgress() {
  const { status, running, isModelLoaded, loadModel, cancelModelDownload } =
    useAiController();
  const dl = status?.model_download;
  if (!dl || !downloadRelevant(dl.status, isModelLoaded)) return null;
  const done = dl.done ?? 0;
  const total = dl.total ?? 0;
  const pct = taskPct(dl) ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        {dl.status === "downloading" ? (
          <span className="text-neutral-200">
            Downloading {shortRepo(status?.model?.repo)}
            {total > 0 && (
              <span className="text-muted tabular-nums">
                {" "}
                · {formatBytes(done)} of {formatBytes(total)}
              </span>
            )}
            {dl.cancel_requested && <span className="text-faint"> (cancelling)</span>}
          </span>
        ) : dl.status === "error" ? (
          <span className="text-red-300">
            Model download failed{dl.error ? `: ${dl.error}` : ""}
          </span>
        ) : (
          <span className="text-muted">Model download cancelled</span>
        )}
        {dl.status === "downloading" ? (
          <Button size="sm" onClick={cancelModelDownload} disabled={running}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={loadModel} disabled={running}>
            Retry
          </Button>
        )}
      </div>
      {dl.status === "downloading" && (
        <ProgressBar value={pct} aria-label="Model download progress" />
      )}
    </div>
  );
}

/**
 * One quiet line about the model for the AI Tagging page. Silent detail in
 * the normal case; download progress, loading, or an error when they happen.
 */
export function ModelStatusLine() {
  const { status, isModelLoaded, isModelLoading, loadModel, running } =
    useAiController();
  if (downloadRelevant(status?.model_download?.status, isModelLoaded)) {
    return <DownloadProgress />;
  }

  // The status repo is only set once loaded; the configured one names it before.
  const name = shortRepo(status?.model?.repo || status?.settings?.model_repo);
  const loadError = status?.model_load?.error;
  if (loadError) {
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="inline-flex items-center gap-1.5 text-red-300 min-w-0">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="truncate">Couldn't load {name}: {loadError}</span>
        </span>
        <Button size="sm" onClick={loadModel} disabled={running}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div className="text-xs text-faint">
      {isModelLoading ? (
        <span className="inline-flex items-center gap-1.5 text-muted">
          <Loader2 size={12} className="animate-spin" /> Loading {name}…
        </span>
      ) : (
        <>
          Uses <span className="text-muted">{name}</span>
          {isModelLoaded ? ", ready." : ", loaded automatically when tagging starts."}
        </>
      )}{" "}
      <Link to="/settings?section=tagging" className="text-brand-300 hover:underline">
        Model settings
      </Link>
    </div>
  );
}
