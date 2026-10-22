import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "../../lib/cn";
import { STATUS_KEY, testConnection, useComfySettings, useComfyStatus } from "../../lib/generate";
import { RotateCw } from "lucide-react";

/**
 * One status for generating: a dot and a word ("Ready", "Generating",
 * "Needs a test run", "Unreachable"), then where ComfyUI is. Red with Retry
 * and Settings when it is down. `ready` is whether the Generator has passed
 * its test run; leave it out where that doesn't apply ("Connected").
 */
export function ComfyStatusLine({ withActions = true, ready }: { withActions?: boolean; ready?: boolean }) {
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
  const [tone, label] = down
    ? (["bg-red-500", "Unreachable"] as const)
    : status.busy
      ? (["bg-amber-400 animate-pulse", "Generating"] as const)
      : ready === false
        ? (["bg-amber-400", "Needs a test run"] as const)
        : (["bg-emerald-400", ready ? "Ready" : "Connected"] as const);
  return (
    <div role={down ? "alert" : undefined} className="flex shrink-0 items-center gap-2 text-sm">
      <span className={cn("h-2 w-2 rounded-full", tone)} />
      <span className={down ? "text-red-200" : "text-neutral-100"} title={down ? status.error ?? undefined : undefined}>
        {label}
      </span>
      <span className="hidden sm:inline text-faint" title={`ComfyUI at ${address}`}>
        ComfyUI <span className="font-mono">{address}</span>
      </span>
      {down && withActions && (
        <>
          <button
            type="button"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            title="Retry"
            aria-label="Retry"
            className="-mx-1 rounded-md p-1 text-muted hover:bg-raised hover:text-neutral-100 disabled:opacity-60"
          >
            <RotateCw size={14} className={cn(retry.isPending && "animate-spin")} />
          </button>
          <Link to="/settings?section=comfyui" className="text-xs text-muted hover:text-neutral-100">
            Settings
          </Link>
        </>
      )}
    </div>
  );
}
