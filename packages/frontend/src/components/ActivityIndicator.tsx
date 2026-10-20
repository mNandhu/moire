import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronUp, Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { describeTask, type BackgroundTask, type TaskView } from "../lib/backgroundTasks";
import { libraryPageHref, useLibraries } from "../lib/queries";
import { useBackgroundTasks } from "../hooks/useBackgroundTasks";
import { useQueueTitle } from "../hooks/useQueueTitle";
import { ProgressBar } from "./ui";

/** Where a task's own page is, if it has one. */
function hrefOf(t: BackgroundTask): string | null {
  if (t.library_id && t.kind !== "delete") return libraryPageHref(t.library_id);
  if (t.kind === "ai_job" || t.kind === "model_download" || t.kind === "model_load") return "/ai-tagging";
  if (t.kind === "generate") return "/generations";
  return null;
}

function Row({ task, view }: { task: BackgroundTask; view: TaskView }) {
  const href = hrefOf(task);
  const body = (
    <>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="truncate text-neutral-200">{view.title}</span>
        {view.pct != null && <span className="ml-auto tabular-nums text-faint">{view.pct}%</span>}
      </div>
      {view.detail && <div className="truncate text-[11px] text-faint">{view.detail}</div>}
      <ProgressBar
        value={view.pct ?? 0}
        className={cn("mt-1 h-1", view.pct == null && "animate-pulse")}
        aria-label={view.title}
      />
    </>
  );
  return href ? (
    <Link to={href} className="block rounded-md px-2 py-1.5 hover:bg-raised/60">
      {body}
    </Link>
  ) : (
    <div className="px-2 py-1.5">{body}</div>
  );
}

/**
 * The sidebar's line for background work: scans, model downloads, AI
 * tagging, deletes. Hidden when nothing runs; expands into the full list.
 */
export function ActivityIndicator({ collapsed }: { collapsed: boolean }) {
  const { data: tasks = [] } = useBackgroundTasks();
  const { data: libraries } = useLibraries({ poll: false });
  const [open, setOpen] = useState(false);
  useQueueTitle();
  if (!tasks.length) return null;

  const name = (id: string) => {
    const l = libraries?.find((x) => x._id === id);
    return l ? l.name || l.path : undefined;
  };
  const views = tasks.map((t) => ({ task: t, view: describeTask(t, name) }));
  const first = views[0].view;
  const more = views.length - 1;
  const summary = views.map(({ view }) => [view.title, view.detail].filter(Boolean).join(": ")).join("\n");

  if (collapsed) {
    return (
      <div className="flex justify-center py-2 text-brand-300" title={summary} role="status" aria-label={summary}>
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite">
      {open && (
        <div className="mb-1 max-h-72 overflow-y-auto space-y-0.5">
          {views.map(({ task, view }) => (
            <Row key={task.key} task={task} view={view} />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted hover:bg-raised/60 hover:text-neutral-100"
      >
        <Loader2 size={14} className="shrink-0 animate-spin text-brand-300" />
        <span className="min-w-0 flex-1 truncate">
          {open ? "Background work" : first.title}
          {!open && first.pct != null && <span className="tabular-nums text-faint"> {first.pct}%</span>}
        </span>
        {more > 0 && !open && <span className="shrink-0 text-faint">+{more}</span>}
        <ChevronUp size={14} className={cn("shrink-0 transition-transform", !open && "rotate-180")} />
      </button>
    </div>
  );
}
