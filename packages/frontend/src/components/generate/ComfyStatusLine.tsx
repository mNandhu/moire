import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/cn";
import { STATUS_KEY, testConnection, useComfySettings, useComfyStatus } from "../../lib/generate";
import { Button } from "../ui";

/** "ComfyUI 127.0.0.1:8188 | idle", red with Retry and Settings when down. */
export function ComfyStatusLine({ withActions = true }: { withActions?: boolean }) {
  const qc = useQueryClient();
  const { data: status } = useComfyStatus();
  const { data: settings } = useComfySettings();
  const retry = useMutation({
    mutationFn: testConnection,
    onSettled: () => qc.invalidateQueries({ queryKey: STATUS_KEY }),
  });
  if (!status?.configured) return null;
  const down = !status.connected;
  const address = (settings?.address ?? "").replace(/^https?:\/\//, "");
  return (
    <div role={down ? "alert" : undefined} className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          down ? "bg-red-500" : status.busy ? "bg-amber-400" : "bg-emerald-400",
        )}
      />
      <span>
        ComfyUI <span className="font-mono text-faint">{address}</span>
      </span>
      <span className="text-line-strong">|</span>
      <span className={down ? "text-red-200" : undefined} title={down ? status.error ?? undefined : undefined}>
        {down ? "unreachable" : status.busy ? "busy" : "idle"}
      </span>
      {down && withActions && (
        <>
          <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
            Retry
          </Button>
          <Link to="/settings?section=comfyui" className="text-xs text-muted hover:text-neutral-100">
            Settings
          </Link>
        </>
      )}
    </div>
  );
}
