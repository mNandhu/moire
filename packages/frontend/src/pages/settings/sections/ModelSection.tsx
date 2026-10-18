import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { formatBytes, useSettings } from "../SettingsContext";

export function ModelSection() {
  const {
    status,
    running,
    isModelLoaded,
    isModelLoading,
    loadModel,
    cancelModelLoad,
    cancelModelDownload,
    unloadModel,
  } = useSettings();

  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Badge
            tone={
              isModelLoading
                ? "warning"
                : status?.model?.loaded
                  ? "success"
                  : "neutral"
            }
          >
            {isModelLoading
              ? "loading"
              : status?.model?.loaded
                ? "loaded"
                : "unloaded"}
          </Badge>
          <div className="text-xs text-neutral-400">
            {status?.model?.repo ? status.model.repo : ""}
          </div>
          {status?.model_load?.error && (
            <div className="text-xs text-red-300 mt-1">
              {status.model_load.error}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {!isModelLoaded && !isModelLoading && (
            <Button onClick={loadModel} disabled={running}>
              Load
            </Button>
          )}

          {isModelLoading && (
            <Button
              variant="dangerSoft"
              onClick={cancelModelLoad}
              disabled={running}
              title="Stops an in-progress download/load."
            >
              Stop
            </Button>
          )}

          {isModelLoaded && !isModelLoading && (
            <Button onClick={unloadModel} disabled={running}>
              Unload
            </Button>
          )}
        </div>
      </div>

      {status?.model_download &&
        ["downloading", "error", "cancelled"].includes(
          status.model_download.status
        ) && (
          <div
            className={`rounded border p-3 space-y-2 ${
              status.model_download.status === "error"
                ? "border-red-900/60 bg-red-950/20"
                : "border-neutral-800 bg-neutral-950/40"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm">
                {status.model_download.status === "downloading" ? (
                  <>
                    Downloading model files…
                    {status.model_download.cancel_requested ? (
                      <span className="text-faint"> (cancelling)</span>
                    ) : null}
                  </>
                ) : status.model_download.status === "error" ? (
                  <span className="text-red-300">
                    Download failed
                    {status.model_download.error
                      ? `: ${status.model_download.error}`
                      : ""}
                  </span>
                ) : (
                  <span className="text-neutral-400">Download cancelled</span>
                )}
              </div>
              {status.model_download.status === "downloading" ? (
                <Button
                  size="sm"
                  variant="dangerSoft"
                  onClick={cancelModelDownload}
                  disabled={running}
                  title="Cancel the current download (partial files will be removed)."
                >
                  Cancel download
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={loadModel}
                  disabled={running}
                  title="Retry downloading and loading the model."
                >
                  Retry
                </Button>
              )}
            </div>

            {(status.model_download.files || []).map((f) => {
              const pct =
                f.total && f.total > 0
                  ? Math.min(100, Math.round((f.downloaded / f.total) * 100))
                  : 0;
              return (
                <div key={f.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-neutral-400">
                    <div>
                      <span className="font-mono">{f.name}</span> · {f.status}
                      {f.error ? (
                        <span className="text-red-300"> · {f.error}</span>
                      ) : null}
                    </div>
                    <div className="text-faint">
                      {formatBytes(f.downloaded)}
                      {f.total ? ` / ${formatBytes(f.total)}` : ""}
                    </div>
                  </div>
                  <progress
                    className="w-full h-2 [&::-webkit-progress-bar]:bg-neutral-800 [&::-webkit-progress-value]:bg-emerald-600 [&::-moz-progress-bar]:bg-emerald-600"
                    value={pct}
                    max={100}
                  />
                </div>
              );
            })}
          </div>
        )}
    </Card>
  );
}
