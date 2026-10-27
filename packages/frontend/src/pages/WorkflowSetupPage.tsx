import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Loader2, Trash2 } from "lucide-react";
import { Button, Card, EmptyState, PageBody, PageHeader, Tooltip } from "../components/ui";
import { SetupForm } from "../components/workflow-setup/SetupForm";
import { SourceStep } from "../components/workflow-setup/SourceStep";
import { TestStep } from "../components/workflow-setup/TestStep";
import {
  GENERATORS_KEY,
  createGenerator,
  deleteGenerator,
  discoverGenerator,
  generatorDiscoverKey,
  generatorLatestKey,
  generatorSetupKey,
  getGeneratorLatest,
  getGeneratorSetup,
  putGenerator,
  startTest,
  useGenerators,
  type GeneratorSlots,
  type GeneratorSourceIn,
} from "../lib/generate";
import { defaultName, workflowOrigin } from "../lib/generatorSetup";
import { errorText } from "../lib/api";
import { useConfirm } from "../components/ConfirmDialog";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

/** A short stable hash of a string: an uploaded graph's cache key. */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export default function WorkflowSetupPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const image = params.get("image");
  // Moving a saved workflow to a newer version: that version's image.
  const updateTo = id ? params.get("update") : null;
  const [source, setSource] = useState<GeneratorSourceIn | null>(image ? { image_id: image } : null);
  useEffect(() => {
    if (image) setSource({ image_id: image });
  }, [image]);
  const { data: generators } = useGenerators();
  const saved = id ? generators?.find((g) => g._id === id) : undefined;
  useDocumentTitle(saved ? `Set up ${saved.name}` : "Set up a workflow");

  const sourceKey = useMemo(
    () => (source && "image_id" in source ? source.image_id : source ? `upload:${hashOf(JSON.stringify(source))}` : null),
    [source],
  );
  const discovered = useQuery({
    queryKey: generatorDiscoverKey(sourceKey),
    queryFn: () => discoverGenerator(source!),
    enabled: !id && !!source,
    retry: false,
    staleTime: Infinity,
  });
  const existing = useQuery({
    queryKey: [...generatorSetupKey(id), updateTo],
    queryFn: ({ signal }) => getGeneratorSetup(id!, signal, updateTo),
    enabled: !!id,
    retry: false,
  });
  const latest = useQuery({
    queryKey: generatorLatestKey(id),
    queryFn: ({ signal }) => getGeneratorLatest(id!, signal),
    enabled: !!id && !updateTo,
  });
  const newer = latest.data?.newer;
  const setup = id ? existing.data : discovered.data;
  const loadError = (id ? existing.error : discovered.error) as Error | null;

  const create = useMutation({
    mutationFn: async (v: { name: string; slots: GeneratorSlots; defaults: { base: string; negative: string } }) => {
      const gen = await createGenerator({ source: source!, ...v });
      try {
        await startTest(gen._id, null);
      } catch (e) {
        toast.push(`Saved. The test didn't start: ${errorText(e)}`, "error");
      }
      return gen;
    },
    onSuccess: (gen) => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      navigate(`/generate/workflows/${gen._id}`, { replace: true });
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });
  const update = useMutation({
    mutationFn: (v: { name: string; slots: GeneratorSlots; defaults: { base: string; negative: string } }) =>
      putGenerator(id!, updateTo ? { ...v, source: { image_id: updateTo } } : v),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      void qc.invalidateQueries({ queryKey: generatorSetupKey(id) });
      void qc.invalidateQueries({ queryKey: generatorLatestKey(id) });
      if (updateTo) setParams({}, { replace: true });
      toast.push(g.ready ? "Saved" : "Saved. Run the test again before queueing.", "success");
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => deleteGenerator(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      navigate("/generate");
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });

  const title = saved ? `Set up "${saved.name}"` : setup ? `Set up "${defaultName(setup)}"` : "Set up a workflow";
  const origin = workflowOrigin(setup?.source);

  return (
    <>
      <PageHeader
        title={title}
        description={origin}
        width="wide"
        actions={
          id && (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${saved?.name ?? "this workflow"}?`,
                  message: "Its setup and test run go. Batches made with it stay, and so do their images.",
                  confirmLabel: "Delete workflow",
                  tone: "danger",
                });
                if (ok) remove.mutate();
              }}
            >
              <Trash2 size={14} /> Delete
            </Button>
          )
        }
      />
      <PageBody width="wide">
        <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-faint">
          <Link to="/generate" className="text-muted hover:text-neutral-100">
            Generate
          </Link>
          <span className="mx-1.5">/</span>
          {id ? "Workflow setup" : "Set up a workflow"}
        </nav>
        {id && newer && (
          <Card className="mb-4 flex flex-wrap items-center gap-3 border-brand-700/60 p-4">
            <span className="text-sm text-neutral-100">
              A newer version is in your library: version {newer.version} of {newer.versions}.
            </span>
            <Tooltip content="Opens it here with your choices carried over where its nodes still fit. Saving puts the workflow back behind a test run.">
              <Button size="sm" className="ml-auto" onClick={() => setParams({ update: newer.image_id })}>
                Update to it
              </Button>
            </Tooltip>
          </Card>
        )}
        {id && updateTo && (
          <Card className="mb-4 flex flex-wrap items-center gap-3 p-4">
            <span className="text-sm text-neutral-100">Updating to the newer version. Check the slots, then save.</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setParams({}, { replace: true })}>
              Keep the current one
            </Button>
          </Card>
        )}
        {id && !updateTo && <div className="mb-4"><TestStep id={id} /></div>}
        {!id && !source ? (
          <SourceStep onSource={setSource} error={null} />
        ) : loadError ? (
          id ? (
            <EmptyState icon={CircleAlert} title={loadError.message} />
          ) : (
            <SourceStep onSource={setSource} error={loadError.message} />
          )
        ) : !setup || (id && !saved) ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : (
          <SetupForm
            key={`${id ?? sourceKey ?? ""}:${updateTo ?? ""}`}
            setup={setup}
            initialName={saved?.name ?? defaultName(setup)}
            saving={create.isPending || update.isPending}
            saveLabel={updateTo ? "Update and save" : id ? "Save" : "Save and run test"}
            onSave={(v) => (id ? update.mutate(v) : create.mutate(v))}
          />
        )}
      </PageBody>
    </>
  );
}
