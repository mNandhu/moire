import { Button } from "../../../components/ui/Button";
import { DownloadProgress } from "../../../components/ai/ModelStatus";
import { useAiController } from "../../../hooks/useAiController";

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
  } = useAiController();
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
