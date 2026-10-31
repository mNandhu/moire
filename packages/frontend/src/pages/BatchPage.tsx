import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, ButtonLink, PageBody, PageHeader } from "../components/ui";
import { InlineRename } from "../components/InlineRename";
import { batchStats, stateTone, STATE_LABEL, whenLabel } from "../lib/batches";
import { durationWords } from "../lib/format";
import { leftLabel } from "../lib/eta";
import { renameBatch, requeueBatch, useBatch, type Batch } from "../lib/generate";
import { useBatchChanged, useCancelBatch, useRetryFailed } from "../hooks/useBatchActions";
import { saveDraft } from "../lib/generateDraft";
import { formFromBatch } from "../lib/remixForm";
import { BatchInputs } from "../components/generate/BatchInputs";
import { BatchResults } from "../components/generate/BatchResults";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

function NameHeading({ b, onSaved }: { b: Batch; onSaved: (b: Batch) => void }) {
  const save = useMutation({ mutationFn: (name: string) => renameBatch(b._id, name), onSuccess: onSaved });
  return (
    <InlineRename
      value={b.name}
      label="batch"
      onCommit={(name) => {
        if (name && name !== b.name) save.mutate(name);
      }}
      className="inline-flex"
      inputClassName="w-72"
    />
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
  const retryAll = useRetryFailed(batchId, changed);

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

  const { images, inLibrary, runs, perRun, took, left, failed, unfinished } = batchStats(b);

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
            {unfinished > 0 && (
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
            {images} {images === 1 ? "image" : "images"}
          </span>
          <span>
            {runs} {runs === 1 ? "run" : "runs"}
            {perRun != null && perRun > 1 ? ` of ${perRun}` : ""}
          </span>
          {took && (
            <span title="Time ComfyUI spent generating">
              Took {durationWords(took.total)}
              {took.perImage != null && took.images > 1 && `, ${durationWords(took.perImage)} per image`}
            </span>
          )}
          {inLibrary < images && <span>{inLibrary} in library</span>}
          {unfinished > 0 && <span>{unfinished} running</span>}
          {left && <span title="From how long the same work took before">{leftLabel(left)}</span>}
          {failed.length > 0 && <span className="text-red-300">{failed.length} failed</span>}
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <BatchResults batch={b} onChanged={changed} />
          </div>
          <aside>
            <BatchInputs b={b} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
