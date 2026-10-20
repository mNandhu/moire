import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, RotateCcw, Star, X } from "lucide-react";
import { Badge, Button, Card, Input, PageBody, PageHeader, ProgressBar } from "../components/ui";
import { stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { displayWord } from "../lib/compose";
import {
  BATCHES_KEY,
  STATUS_KEY,
  batchKey,
  cancelBatch,
  cancelRequest,
  renameBatch,
  requeueBatch,
  retryRequest,
  thumbUrl,
  useBatch,
  type Batch,
  type GenRequest,
  type Output,
} from "../lib/generate";
import { setQuarantine, setScore } from "../lib/imageMutations";
import { formFromBatch, saveDraft } from "../lib/generateForm";
import { withBackgroundLocation } from "../lib/backgroundLocation";
import { cn } from "../lib/cn";
import { stemOf } from "../components/generate/RunControls";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

const UNFINISHED = new Set(["pending", "queued", "running"]);

function Tile({ out, ratio, onChanged }: { out: Output; ratio: number; onChanged: () => void }) {
  const location = useLocation();
  const toast = useToast();
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!out.in_library) return;
    const k = e.key.toLowerCase();
    if (k === "k") void act(() => setQuarantine(out.image_id, false));
    else if (k === "x") void act(() => setQuarantine(out.image_id, true));
    else if (/^[1-5]$/.test(k)) void act(() => setScore(out.image_id, Number(k)));
  };
  if (!out.in_library) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint"
        style={{ aspectRatio: ratio }}
        title={out.filename}
      >
        <Loader2 size={14} className="mr-1.5 animate-spin" /> Scanning
      </div>
    );
  }
  return (
    <div
      tabIndex={0}
      onKeyDown={onKeyDown}
      title="K keep · X reject · 1 to 5 score"
      className={cn(
        "group relative overflow-hidden rounded-lg bg-raised outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
        out.quarantined && "opacity-60",
      )}
      style={{ aspectRatio: ratio }}
    >
      <Link to={`/image/${encodeURIComponent(out.image_id)}`} state={withBackgroundLocation(location)} tabIndex={-1}>
        <img src={thumbUrl(out.image_id)} alt="" loading="lazy" className="h-full w-full object-cover" />
      </Link>
      {out.quarantined && (
        <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-black/60 px-2 py-1 text-xs">
          <span className="text-red-200">Rejected</span>
          <button type="button" className="text-neutral-100 hover:underline" onClick={() => act(() => setQuarantine(out.image_id, false))}>
            Restore
          </button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`Score ${n}`}
            onClick={() => act(() => setScore(out.image_id, n))}
            className="text-neutral-300 hover:text-amber-300"
          >
            <Star size={14} className={cn((out.score ?? 0) >= n && "fill-amber-300 text-amber-300")} />
          </button>
        ))}
        <span className="flex-1" />
        {!out.quarantined && (
          <button
            type="button"
            aria-label="Reject"
            title="Reject"
            onClick={() => act(() => setQuarantine(out.image_id, true))}
            className="rounded p-0.5 text-neutral-300 hover:text-red-300"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function RequestGroup({
  batch,
  req,
  number,
  ratio,
  onChanged,
}: {
  batch: Batch;
  req: GenRequest;
  number: number;
  ratio: number;
  onChanged: (b?: Batch) => void;
}) {
  const retry = useMutation({
    mutationFn: (single: boolean) => retryRequest(batch._id, req._id, single),
    onSuccess: (b) => onChanged(b),
  });
  const cancel = useMutation({ mutationFn: () => cancelRequest(batch._id, req._id), onSuccess: (b) => onChanged(b) });
  const failed = req.state === "failed" || req.state === "lost";
  const empty = req.state === "done" && req.outputs.length === 0;
  const slots = req.outputs.length ? req.outputs.length : (req.images ?? 1);
  const pct = req.progress && req.progress.max ? (req.progress.value / req.progress.max) * 100 : 0;

  return (
    <section aria-label={`Request ${number}`}>
      <div className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span className="text-neutral-200">Request {number}</span>
        <span className="font-mono text-faint">seed {req.seed}</span>
        {req.state === "cancelled" && <Badge>Cancelled</Badge>}
      </div>
      {failed || empty ? (
        <Card className="border-red-900/60 p-3.5">
          <div className="text-sm text-red-200">
            {empty
              ? "Returned 0 images"
              : req.state === "lost"
                ? "Lost"
                : `Failed${req.images && req.images > 1 ? `, ${req.images} images` : ""}`}
          </div>
          {req.error && (
            <div className="mt-1 font-mono text-xs text-red-300">
              {req.error.class_type} {req.error.node && <span className="text-faint">node {req.error.node}</span>}
              <div className="mt-0.5 break-words">
                {req.error.type ? `${req.error.type}: ` : ""}
                {req.error.message}
              </div>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => retry.mutate(false)} disabled={retry.isPending}>
              <RotateCcw size={13} /> Retry
            </Button>
            {req.images != null && req.images > 1 && (
              <Button size="sm" variant="ghost" onClick={() => retry.mutate(true)} disabled={retry.isPending}>
                Retry one at a time
              </Button>
            )}
          </div>
        </Card>
      ) : UNFINISHED.has(req.state) ? (
        <Card className="p-3.5">
          <div className="flex items-center gap-3 text-sm">
            {req.state === "running" ? (
              <>
                <span className="text-neutral-100">Running</span>
                {req.progress && (
                  <span className="font-mono text-xs text-faint">
                    {req.progress.value} / {req.progress.max}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted">{req.state === "queued" ? "Queued in ComfyUI" : "Waiting"}</span>
            )}
            <span className="flex-1" />
            <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </Button>
          </div>
          {req.state === "running" && <ProgressBar value={pct} className="mt-2" />}
          <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
            {Array.from({ length: slots }, (_, i) => (
              <div key={i} className="rounded-lg bg-raised/60 animate-pulse" style={{ aspectRatio: ratio }} />
            ))}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
          {req.outputs.map((o) => (
            <Tile key={o.idx} out={o} ratio={ratio} onChanged={() => onChanged()} />
          ))}
        </div>
      )}
    </section>
  );
}

function PromptPanel({ b }: { b: Batch }) {
  const i = b.inputs;
  const row = (k: string, v: React.ReactNode) => (
    <div className="contents">
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 break-words text-neutral-200">{v}</dd>
    </div>
  );
  return (
    <Card className="p-4 text-sm">
      <div className="mb-3 font-medium text-neutral-100">Prompt</div>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        {row("Generator", b.generator.name ?? b.generator._id)}
        {i.checkpoint && row("Checkpoint", <span className="font-mono">{stemOf(i.checkpoint)}</span>)}
        {i.character &&
          row(
            "Character",
            <>
              {i.character.label || displayWord(i.character.tag)}
              {i.character.tags.length > 1 && (
                <span className="text-muted"> + {i.character.tags.slice(1).map(displayWord).join(", ")}</span>
              )}
            </>,
          )}
        {i.character?.lora &&
          row(
            "Character LoRA",
            <span className="font-mono">
              {stemOf(i.character.lora.name)} {i.character.lora.strength.toFixed(2)}
            </span>,
          )}
        {i.loras.length > 0 &&
          row(
            i.character ? "Style LoRAs" : "LoRAs",
            i.loras.map((l) => (
              <span key={l.name} className="mr-2 font-mono">
                {stemOf(l.name)} {l.strength.toFixed(2)}
              </span>
            )),
          )}
        {i.extra.length > 0 && row("Extra", i.extra.map(displayWord).join(", "))}
        {i.width && i.height && row("Size", `${i.width} × ${i.height}`)}
        {i.per_request != null && row("Per request", `${i.per_request} ${i.per_request === 1 ? "image" : "images"}`)}
        {row("Seeds", <span className="font-mono">{b.requests.map((q) => q.seed).join(", ")}</span>)}
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">Prompt as sent</summary>
        <p className="mt-2 break-words font-mono text-xs text-neutral-300">{i.positive_text}</p>
        {i.negative_text && <p className="mt-2 break-words font-mono text-xs text-faint">{i.negative_text}</p>}
      </details>
    </Card>
  );
}

function NameHeading({ b, onSaved }: { b: Batch; onSaved: (b: Batch) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(b.name);
  const save = useMutation({ mutationFn: (name: string) => renameBatch(b._id, name), onSuccess: onSaved });
  if (editing) {
    const commit = () => {
      if (draft.trim() && draft.trim() !== b.name) save.mutate(draft.trim());
      setEditing(false);
    };
    return (
      <span className="inline-flex items-center gap-2">
        <Input
          autoFocus
          aria-label="Batch name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-72"
        />
        <Button size="iconSm" variant="ghost" aria-label="Save" onClick={commit}>
          <Check size={15} />
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      {b.name}
      <button
        type="button"
        aria-label="Rename batch"
        title="Rename"
        onClick={() => {
          setDraft(b.name);
          setEditing(true);
        }}
        className="rounded p-1 text-muted hover:bg-raised hover:text-neutral-100"
      >
        <Pencil size={14} />
      </button>
    </span>
  );
}

export default function BatchPage() {
  const { id } = useParams();
  const batchId = Number(id);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: b, isLoading, error } = useBatch(batchId);
  useDocumentTitle(b?.name);

  const changed = (next?: Batch) => {
    if (next) qc.setQueryData(batchKey(batchId), next);
    else void qc.invalidateQueries({ queryKey: batchKey(batchId) });
    void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    void qc.invalidateQueries({ queryKey: STATUS_KEY });
  };
  const requeue = useMutation({
    mutationFn: () => requeueBatch(batchId),
    onSuccess: (nb) => {
      changed();
      navigate(`/generations/${nb._id}`);
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  const cancelAll = useMutation({ mutationFn: () => cancelBatch(batchId), onSuccess: (nb) => changed(nb) });
  const retryAll = useMutation({
    mutationFn: async () => {
      let last: Batch | undefined;
      for (const q of b!.requests.filter((q) => q.state === "failed" || q.state === "lost")) {
        last = await retryRequest(batchId, q._id);
      }
      return last;
    },
    onSuccess: (nb) => changed(nb),
  });

  if (isLoading) return <PageHeader title="Batch" />;
  if (error || !b) {
    return (
      <>
        <PageHeader title="Batch not found" />
        <PageBody>
          <Link to="/generations" className="text-sm text-muted hover:text-neutral-100">
            All generations
          </Link>
        </PageBody>
      </>
    );
  }

  const ratio = b.inputs.width && b.inputs.height ? b.inputs.width / b.inputs.height : 2 / 3;
  const outputs = b.requests.flatMap((q) => q.outputs);
  const failed = b.requests.filter((q) => q.state === "failed" || q.state === "lost");
  const running = b.requests.filter((q) => UNFINISHED.has(q.state)).length;
  const inLibrary = outputs.filter((o) => o.in_library).length;
  const perReq = b.inputs.per_request;

  return (
    <>
      <PageHeader
        title={<NameHeading b={b} onSaved={(nb) => changed(nb)} />}
        width="wide"
        actions={
          <div className="flex flex-wrap gap-2">
            {b.requests.some((q) => UNFINISHED.has(q.state)) && (
              <Button size="sm" variant="ghost" onClick={() => cancelAll.mutate()} disabled={cancelAll.isPending}>
                Cancel batch
              </Button>
            )}
            {failed.length > 0 && (
              <Button size="sm" onClick={() => retryAll.mutate()} disabled={retryAll.isPending}>
                Retry failed ({failed.length})
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                saveDraft(formFromBatch(b.inputs, b.auto_name ? null : b.name));
                navigate("/generate");
              }}
            >
              Edit and queue
            </Button>
            <Button size="sm" variant="primary" onClick={() => requeue.mutate()} disabled={requeue.isPending}>
              Queue again
            </Button>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <Link to="/generations" className="hover:text-neutral-100">
            Generations
          </Link>
          <span className="text-faint">/</span>
          <span>Batch {b._id}</span>
          <Badge tone={stateTone(b.state)}>{STATE_LABEL[b.state]}</Badge>
          <span className="text-faint">Queued {whenLabel(b.created_at)}</span>
        </div>
      </PageHeader>
      <PageBody width="wide">
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          <span>
            {outputs.length} {outputs.length === 1 ? "image" : "images"}
          </span>
          <span>
            {b.requests.length} {b.requests.length === 1 ? "request" : "requests"}
            {perReq != null && perReq > 1 ? ` of ${perReq}` : ""}
          </span>
          {inLibrary < outputs.length && <span>{inLibrary} in library</span>}
          {running > 0 && <span>{running} running</span>}
          {failed.length > 0 && <span className="text-red-300">{failed.length} failed</span>}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-5">
            {b.requests.map((q, i) => (
              <RequestGroup key={q._id} batch={b} req={q} number={i + 1} ratio={ratio} onChanged={changed} />
            ))}
          </div>
          <aside>
            <PromptPanel b={b} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
