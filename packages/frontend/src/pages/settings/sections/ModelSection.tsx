import { Link } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import { formatBytes, useSettings } from "../SettingsContext";

/**
 * The tagger model loads on demand (a job's first image waits for it) and
 * unloads after `idle_unload_s` idle, so its residency is plumbing. The UI
 * only speaks up when that plumbing affects the user: a first-run download,
 * a load in progress, or a failure to retry. Manual preload/unload is an
 * advanced control and lives in Settings ({@link ModelSection}).
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
function DownloadProgress() {
  const { status, running, isModelLoaded, loadModel, cancelModelDownload } =
    useSettings();
  const dl = status?.model_download;
  if (!dl || !downloadRelevant(dl.status, isModelLoaded)) return null;
  const files = dl.files || [];
  const done = files.reduce((n, f) => n + (f.downloaded || 0), 0);
  const total = files.reduce((n, f) => n + (f.total || 0), 0);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

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
  const { status, settings, isModelLoaded, isModelLoading, loadModel, running } =
    useSettings();
  if (downloadRelevant(status?.model_download?.status, isModelLoaded)) {
    return <DownloadProgress />;
  }

  // The status repo is only set once loaded; the configured one names it before.
  const name = shortRepo(status?.model?.repo || settings?.model_repo);
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

/** Settings: model state with the manual preload/unload controls. */
export function ModelSection() {
  const {
    status,
    running,
    isModelLoaded,
    isModelLoading,
    loadModel,
    cancelModelLoad,
    unloadModel,
  } = useSettings();
  const idle = status?.model?.idle_unload_s;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm">
          <div className="text-neutral-200">
            {isModelLoading ? "Loading…" : isModelLoaded ? "Loaded in memory" : "Not loaded"}
          </div>
          <div className="text-xs text-faint mt-0.5">
            Loads automatically when tagging starts
            {idle ? `; unloads after ${Math.round(idle / 60) || 1} min idle` : ""}.
          </div>
          {status?.model_load?.error && (
            <div className="text-xs text-red-300 mt-1">{status.model_load.error}</div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {isModelLoading ? (
            <Button size="sm" onClick={cancelModelLoad} disabled={running}>
              Stop
            </Button>
          ) : isModelLoaded ? (
            <Button size="sm" onClick={unloadModel} disabled={running}>
              Unload now
            </Button>
          ) : (
            <Button size="sm" onClick={loadModel} disabled={running}>
              Preload
            </Button>
          )}
        </div>
      </div>
      <DownloadProgress />
    </div>
  );
}
