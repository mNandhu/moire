import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Loader2, Plus, RotateCcw, Sparkles, X } from "lucide-react";
import { errorText } from "../../lib/api";
import { aiJobLabel } from "../../lib/ai";
import { describeTask } from "../../lib/backgroundTasks";
import { applyTags } from "../../lib/imageMutations";
import type { FlowTag } from "../../lib/tags";
import { useAiTagging } from "../../hooks/useAiTagging";
import { useBackgroundTasks } from "../../hooks/useBackgroundTasks";
import { useToast } from "../Toasts";
import { useConfirm } from "../ConfirmDialog";
import { ProgressBar } from "../ui/ProgressBar";
import { Input } from "../ui/Input";
import { TagFlow } from "./TagFlow";
import { TabActions, TAB_ACTION } from "./TabActions";

/** A quiet text action for a section header ("Copy all", "Tag with AI"). */
const HEADER_ACTION = "inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200";

export function TagsSection({
  id,
  onCopyAll,
  onChange,
  tags,
}: {
  id: string;
  onCopyAll: () => void;
  onChange: () => void;
  tags: FlowTag[];
}) {
  const { start, adopt, cancel, submitting, cancelling, jobId, job, canCancel } =
    useAiTagging(onChange, id);
  const hasTags = tags.length > 0;
  // The tagger has already run on it: no "Tag with AI" to offer.
  const aiTagged = tags.some((t) => t.kind === "ai" || t.kind === "character");
  const confirm = useConfirm();
  const retag = async () => {
    const ok = await confirm({
      title: "Re-tag this image with AI?",
      message:
        "All of its AI tags are removed and its rating is reset, then the tagger runs again. Your own tags and prompt tags stay.",
      confirmLabel: "Remove and re-tag",
      tone: "warning",
    });
    if (!ok) return;
    await start([id], { retag: true });
    // Show the cleared tags now; the job's end refreshes again.
    onChange();
  };
  const { data: tasks } = useBackgroundTasks();
  // A job tagging this image that the panel doesn't know (after a reload,
  // or from another tab); one started here it picks up by itself.
  const running = tasks?.find((t) => t.kind === "ai_job" && t.image_id === id)?.job_id;
  useEffect(() => {
    if (running) adopt(running);
  }, [running, adopt]);
  // The tagging model is shared: its download or load shows on every
  // image's panel, whichever image started it.
  const model = tasks?.find((t) => t.kind === "model_download" || t.kind === "model_load");
  const modelView = model ? describeTask(model) : null;
  const busy = submitting || Boolean(jobId);
  // This image's job, when it has one, names the line (its X cancels the
  // job); the model's progress shows on it while the job waits for it.
  const waitsForModel = !busy || job?.phase === "model";
  const jobLabel = submitting
    ? "Starting…"
    : aiJobLabel(job ?? (jobId ? { status: "queued" } : null));

  return (
    <section className="px-4 py-4 space-y-3">
      <TabActions>
        {/* While it runs, the status line below says so. */}
        {!busy &&
          (aiTagged ? (
            <button
              type="button"
              onClick={() => void retag()}
              className={TAB_ACTION}
              title="Re-tag with AI: remove its AI tags and rating, and tag it again"
              aria-label="Re-tag with AI"
            >
              <RotateCcw size={15} />
            </button>
          ) : (
            // Untagged, tagging is the thing to do here: worth its words.
            <button
              type="button"
              onClick={() => void start([id])}
              className={HEADER_ACTION}
              title="Tag this image with the AI tagger"
            >
              <Sparkles size={12} /> Tag with AI
            </button>
          ))}
        {hasTags && (
          <button
            type="button"
            onClick={onCopyAll}
            className={TAB_ACTION}
            title="Copy all tags as prompt text"
            aria-label="Copy all tags"
          >
            <Copy size={15} />
          </button>
        )}
      </TabActions>
      {(busy || modelView) && (
        <AiTagStatus
          label={(busy ? jobLabel : modelView?.title) ?? "Tagging…"}
          pct={waitsForModel ? (modelView?.pct ?? null) : null}
          onCancel={canCancel ? () => void cancel() : undefined}
          cancelling={cancelling || job?.status === "cancelling"}
        />
      )}
      {!hasTags && <div className="text-xs text-faint">No tags yet.</div>}
      {/* Adding sits where the tags end, as one more pill in the run. One
          place either way, so the open field survives the first tag. */}
      <TagFlow key={id} tags={tags} trailing={<AddTags id={id} onAdded={onChange} />} />
    </section>
  );
}

/** One line for this image's AI tagging: the shared model's download or
 * load, else the job's own state. */
function AiTagStatus({
  label,
  pct,
  onCancel,
  cancelling,
}: {
  label: string;
  pct: number | null;
  onCancel?: () => void;
  cancelling: boolean;
}) {
  return (
    <div role="status" className="rounded-lg bg-raised/50 px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <Loader2 size={12} className="shrink-0 animate-spin text-brand-300" />
        <Link
          to="/ai-tagging"
          className="min-w-0 flex-1 truncate text-neutral-200 hover:text-white"
          title="AI tagging jobs"
        >
          {label}
        </Link>
        {pct != null && <span className="tabular-nums text-faint">{pct}%</span>}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            className="-mr-1 rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100 disabled:opacity-50"
            title="Cancel AI tagging"
            aria-label="Cancel AI tagging"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {pct != null && <ProgressBar value={pct} className="h-1" aria-label={label} />}
    </div>
  );
}

/**
 * Manual tags: a small "Add tags" pill that opens into a field, so it costs
 * one line until used. Takes several at once, comma separated; stays open
 * after adding for more, and closes on Escape or when left empty.
 */
function AddTags({ id, onAdded }: { id: string; onAdded: () => void }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [adding, setAdding] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const tags = val
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const add = async () => {
    if (adding || !tags.length) return;
    setAdding(true);
    try {
      await applyTags(id, tags);
      setVal("");
      onAdded();
      // Back to the field for more (the + button took the focus).
      field.current?.focus();
    } catch (e) {
      push(`Couldn't add tags: ${errorText(e)}`, "error");
    } finally {
      setAdding(false);
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Add your own tags"
        className="inline-flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-line text-2xs text-muted hover:text-neutral-100 hover:border-line-strong align-middle"
      >
        <Plus size={11} /> Add tags
      </button>
    );
  }
  return (
    <form
      className="relative mt-1"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <Input
        ref={field}
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setVal("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          if (!val.trim() && !adding) setOpen(false);
        }}
        placeholder="Tags, comma separated"
        aria-label="Add tags"
        className="h-8 text-xs pr-9"
      />
      <button
        type="submit"
        disabled={adding || !tags.length}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted hover:bg-raised hover:text-neutral-100 disabled:opacity-40 disabled:pointer-events-none"
        title={tags.length > 1 ? `Add ${tags.length} tags` : "Add tag"}
        aria-label="Add tags"
      >
        {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
      </button>
    </form>
  );
}
