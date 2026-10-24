import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft, Check, Pencil } from "lucide-react";
import { Badge, Button, ButtonLink, Card, Input, PageBody, PageHeader } from "../components/ui";
import { batchRunTime, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { durationWords } from "../lib/format";
import { batchLeft, leftLabel } from "../lib/eta";
import { displayWord } from "../lib/compose";
import { renameBatch, requeueBatch, useBatch, type Batch } from "../lib/generate";
import { retryable } from "../lib/batchActions";
import { useBatchChanged, useCancelBatch, useRetryFailed } from "../hooks/useBatchActions";
import { formFromBatch, samplingLabel, saveDraft } from "../lib/generateForm";
import { stemOf } from "../components/generate/RunControls";
import { BatchResults } from "../components/generate/BatchResults";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

const UNFINISHED = new Set(["pending", "queued", "running"]);

/** Which layers' text the inputs list shows, and as what. */
const PART_ROW: Partial<Record<string, string>> = { prefix: "Prefix", prompt: "Prompt", style: "LoRA words" };

function PromptPanel({ b }: { b: Batch }) {
  const i = b.inputs;
  // Older batches have one `character`.
  const cast = i.characters ?? (i.character ? [i.character] : []);
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
        {row("Workflow", b.generator.name ?? b.generator._id)}
        {i.checkpoint && row("Checkpoint", <span className="font-mono">{stemOf(i.checkpoint)}</span>)}
        {i.sampling && Object.keys(i.sampling).length > 0 && row("Sampling", samplingLabel(i.sampling))}
        {cast.map((c) => (
          <div key={c.tag} className="contents">
            {row(
              cast.length > 1 ? c.label || displayWord(c.tag) : "Character",
              <>
                {cast.length === 1 && (c.label || displayWord(c.tag))}
                {c.tags.length > 1 && (
                  <span className="text-muted">
                    {cast.length === 1 && " + "}
                    {c.tags.slice(1).map(displayWord).join(", ")}
                  </span>
                )}
                {c.lora && (
                  <span className="ml-2 font-mono text-muted">
                    {stemOf(c.lora.name)} {c.lora.strength.toFixed(2)}
                  </span>
                )}
              </>,
            )}
          </div>
        ))}
        {i.loras.length > 0 &&
          row(
            cast.length ? "Style LoRAs" : "LoRAs",
            i.loras.map((l) => (
              <span key={l.name} className="mr-2 font-mono">
                {stemOf(l.name)} {l.strength.toFixed(2)}
              </span>
            )),
          )}
        {i.positive
          ?.filter((p) => p.kind === "text" && p.text?.trim() && p.role && p.role in PART_ROW)
          .map((p) => (
            <div key={p.role} className="contents">
              {row(PART_ROW[p.role!]!, p.role === "prefix" ? p.label || p.text : p.text)}
            </div>
          ))}
        {i.extra.length > 0 && row("Extra", i.extra.map(displayWord).join(", "))}
        {i.width && i.height && row("Size", `${i.width} × ${i.height}`)}
        {i.per_request != null && row("Per run", `${i.per_request} ${i.per_request === 1 ? "image" : "images"}`)}
        {row(
          b.requests.length > 1 ? "Seeds" : "Seed",
          <span className="font-mono" title={b.requests.map((q) => q.seed).join(", ")}>
            {b.requests[0]?.seed}
            {b.requests.length > 1 && <span className="text-muted"> and {b.requests.length - 1} more</span>}
          </span>,
        )}
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
  const navigate = useNavigate();
  const toast = useToast();
  const { data: b, isLoading, error } = useBatch(batchId);
  useDocumentTitle(b?.name);

  const changed = useBatchChanged(batchId);
  const requeue = useMutation({
    mutationFn: () => requeueBatch(batchId),
    onSuccess: (nb) => {
      changed();
      navigate(`/generations/${nb._id}`);
    },
    onError: (e) => toast.push(e.message, "error"),
  });
  // A batch that never ran is gone: back to the list.
  const cancelAll = useCancelBatch(batchId, { onGone: () => navigate("/generations", { replace: true }) });
  const retryAll = useRetryFailed(b, changed);

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

  const outputs = b.requests.flatMap((q) => q.outputs);
  const took = batchRunTime(b.requests);
  const left = batchLeft(b.requests);
  const failed = retryable(b.requests);
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
            <ButtonLink to="/generate" size="sm" variant="ghost">
              <ArrowLeft size={14} /> Generate
            </ButtonLink>
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
                saveDraft(formFromBatch(b.inputs, b.auto_name ? null : b.name, b.generator._id));
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
            {b.requests.length} {b.requests.length === 1 ? "run" : "runs"}
            {perReq != null && perReq > 1 ? ` of ${perReq}` : ""}
          </span>
          {took && (
            <span title="Time ComfyUI spent generating">
              Took {durationWords(took.total)}
              {took.perImage != null && took.images > 1 && `, ${durationWords(took.perImage)} per image`}
            </span>
          )}
          {inLibrary < outputs.length && <span>{inLibrary} in library</span>}
          {running > 0 && <span>{running} running</span>}
          {left && <span title="From how long the same work took before">{leftLabel(left)}</span>}
          {failed.length > 0 && <span className="text-red-300">{failed.length} failed</span>}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <BatchResults batch={b} onChanged={changed} />
          </div>
          <aside>
            <PromptPanel b={b} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
