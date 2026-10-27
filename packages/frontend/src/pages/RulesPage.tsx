import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRulesetSession } from "../hooks/useRulesetSession";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import { Workflow, MousePointerClick } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/Toasts";
import { useConfirm } from "../components/ConfirmDialog";
import {
  FIELD_LABEL,
  type RuleField,
  type PreviewResult,
  RULES_SIGNATURES_KEY,
  guessMarks as guessMarksOf,
  useSignatures,
  previewRuleset,
} from "../lib/rules";
import type { GenMeta } from "../lib/gen";
import { fetchImage } from "../lib/imageApi";
import { groupWorkflows } from "../lib/workflows";
import { useGenerators } from "../lib/generate";
import { WorkflowFamilyList } from "../components/rules/WorkflowFamilyList";
import { RuleEditor } from "../components/rules/RuleEditor";
import { GraphPanel } from "../components/rules/GraphPanel";
import { errorText } from "../lib/api";

export default function RulesPage() {
  const { push } = useToast();
  const qc = useQueryClient();
  // Read fresh each time the page opens; saves invalidate it.
  const { data: sigData, isPending: sigsPending, error: sigsError } = useSignatures({ staleTime: 0 });
  const sigs = useMemo(() => sigData ?? [], [sigData]);
  // False until the first fetch answers, so "none yet" never flashes first.
  const sigsLoaded = !sigsPending;
  const [activeField, setActiveField] = useState<RuleField>("prompt");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const loadSignatures = useCallback(() => void qc.invalidateQueries({ queryKey: RULES_SIGNATURES_KEY }), [qc]);

  useEffect(() => {
    if (sigsError) push(`Failed to load signatures: ${errorText(sigsError)}`, "error");
  }, [sigsError, push]);

  const families = useMemo(() => groupWorkflows(sigs), [sigs]);
  // Workflows set up to run in Generate, to mark their families and versions.
  const { data: generators } = useGenerators();

  const confirm = useConfirm();
  const session = useRulesetSession({
    notify: push,
    onSaved: loadSignatures,
    confirmDiscard: confirm,
  });
  const {
    selected,
    fields,
    graph,
    isDirty,
    loadFailed,
    loading,
    selectSig,
    removePath,
    save,
    remove,
  } = session;
  const busy = session.busy || previewBusy;

  useUnsavedChangesGuard(isDirty, confirm);

  // A preview belongs to one signature's sample; drop it on switch so its
  // resolved values and green chips don't linger under the next workflow.
  const selectedSig = selected?.workflow_sig ?? null;
  const [previewSig, setPreviewSig] = useState<string | null>(null);
  if (previewSig !== selectedSig) {
    setPreviewSig(selectedSig);
    setPreview(null);
  }
  const selectedSigRef = useRef(selectedSig);
  selectedSigRef.current = selectedSig;

  // Deep link from a specific image (Full View "Edit rule" button):
  // ?sig=<workflow_sig> auto-selects that signature once its row has loaded.
  // Guarded by a ref (not just presence of the param) so it fires once per
  // distinct sig and never fights a later manual selection.
  const [searchParams] = useSearchParams();
  const sigParam = searchParams.get("sig");
  const appliedSigParam = useRef<string | null>(null);
  useEffect(() => {
    if (!sigParam || sigParam === appliedSigParam.current) return;
    const row = sigs.find((s) => s.workflow_sig === sigParam);
    if (!row) return;
    appliedSigParam.current = sigParam;
    void selectSig(row);
  }, [sigParam, sigs, selectSig]);

  // One way to pin, from a graph click, a match or a guess: says so in a toast.
  const pin = useCallback(
    (field: RuleField, path: string) => {
      session.pinPath(field, path);
      push(`Pinned ${path} → ${FIELD_LABEL[field]}`, "info");
    },
    [session, push],
  );
  const pinPath = useCallback((path: string) => pin(activeField, path), [pin, activeField]);

  const runPreview = useCallback(async () => {
    if (!selected) return;
    const sig = selected.workflow_sig;
    setPreviewBusy(true);
    try {
      const res = await previewRuleset(selected.sample_image_id, fields);
      // Ignore a preview that lands after the user switched signature.
      if (selectedSigRef.current === sig) setPreview(res);
    } catch (e) {
      push(`Preview failed: ${errorText(e)}`, "error");
    } finally {
      setPreviewBusy(false);
    }
  }, [selected, fields, push]);

  // `selected` is the row as it was when picked; the list is refetched after
  // a save or reset, so it's the fresh source for whether pins exist.
  const hasRuleset =
    sigs.find((s) => s.workflow_sig === selectedSig)?.has_ruleset ??
    selected?.has_ruleset ??
    false;

  const previewGen = preview?.gen;

  // What the sample image's extraction currently says (the latest preview
  // when there is one), for fields that are only guessed.
  const sampleId = selected?.sample_image_id ?? null;
  const [sampleGen, setSampleGen] = useState<GenMeta | null>(null);
  useEffect(() => {
    setSampleGen(null);
    if (!sampleId) return;
    const ctl = new AbortController();
    fetchImage(sampleId, { signal: ctl.signal })
      .then((doc) => setSampleGen(doc.gen ?? null))
      .catch(() => {});
    return () => ctl.abort();
  }, [sampleId]);
  const currentGen = previewGen ?? sampleGen;
  const guessMarks = useMemo(() => guessMarksOf(currentGen, fields), [currentGen, fields]);

  // Scroll the matched leaf into view so its surrounding node (class_type,
  // sibling inputs) is readable; the user picks the right hit before pinning.
  const graphScrollRef = useRef<HTMLDivElement>(null);
  const revealPath = useCallback((path: string) => {
    const el = graphScrollRef.current?.querySelector<HTMLElement>(
      `[data-graph-path="${path.replace(/"/g, '\\"')}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // Brief flash so the eye lands on the right row after the scroll.
    el.classList.add("ring-1", "ring-brand-400", "rounded");
    setTimeout(() => el.classList.remove("ring-1", "ring-brand-400", "rounded"), 1200);
  }, []);

  return (
    <>
      <PageHeader
        title="Rules"
        count={sigs.length}
        width="wide"
        description="Tell Moiré where prompt, seed and model live in your custom ComfyUI workflows."
      />
      <PageBody width="wide">

      {!sigsLoaded ? (
        <div className="grid grid-cols-12 gap-4" aria-busy="true" aria-label="Loading workflows">
          <div className="col-span-12 lg:col-span-3 space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="hidden lg:block lg:col-span-9 h-96 rounded-xl" />
        </div>
      ) : sigs.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No workflow signatures yet"
          description="Scan a library of ComfyUI images first. Each distinct workflow shape appears here for mapping."
        />
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Workflow picker: one group per saved workflow (family), with
              its versions under it, named after imported files when there
              are any. Dropping .json files or a folder of them anywhere on it
              imports them. */}
          <WorkflowFamilyList
            families={families}
            sigs={sigs}
            generators={generators}
            selectedSig={selectedSig}
            onSelect={(row) => void selectSig(row)}
            onChanged={loadSignatures}
          />

          {!selected ? (
            <div className="col-span-12 lg:col-span-9 rounded-xl border border-dashed border-line">
              <EmptyState
                compact
                icon={MousePointerClick}
                title="Pick a workflow"
                description="Choose one on the left to see its graph. Click any value in it to say which field it is (say, the node that holds your positive prompt)."
              />
            </div>
          ) : (
            <div className="col-span-12 lg:col-span-9 grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Field editors + actions */}
              <RuleEditor
                selected={selected}
                fields={fields}
                generators={generators}
                preview={preview}
                currentGen={currentGen}
                activeField={activeField}
                onActiveField={setActiveField}
                busy={busy}
                loading={loading}
                loadFailed={loadFailed}
                isDirty={isDirty}
                hasRuleset={hasRuleset}
                onPreview={() => void runPreview()}
                onSave={() => void save()}
                onRemove={() => void remove()}
                onRemovePath={removePath}
                onPin={pin}
                onReveal={revealPath}
              />

              {/* Raw graph tree */}
              <GraphPanel
                graph={graph}
                scrollRef={graphScrollRef}
                activeField={activeField}
                marks={guessMarks}
                onPin={pinPath}
                onReveal={revealPath}
              />
            </div>
          )}
        </div>
      )}
      </PageBody>
    </>
  );
}
