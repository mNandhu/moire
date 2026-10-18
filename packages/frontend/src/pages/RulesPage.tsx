import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRulesetSession } from "../hooks/useRulesetSession";
import { useUnsavedChangesGuard } from "../hooks/useUnsavedChangesGuard";
import {
  Workflow,
  Save,
  Trash2,
  Play,
  X,
  Plus,
  Search,
  AlertTriangle,
  MousePointerClick,
} from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/Toasts";
import { useConfirm } from "../components/ConfirmDialog";
import {
  RULE_FIELDS,
  type RuleField,
  type SignatureRow,
  type PreviewResult,
  fetchSignatures,
  previewRuleset,
  signatureTitle,
} from "../lib/gen";

const FIELD_LABEL: Record<RuleField, string> = {
  prompt: "Positive prompt",
  negative: "Negative prompt",
  seed: "Seed",
  model: "Model",
  sampler: "Sampler",
  steps: "Steps",
  cfg: "CFG",
};

// Does a key or any descendant value contain the (lowercased) search term?
// Drives both the highlight and the auto-expand: a node matches when its own key
// matches (e.g. node id "34"), or any nested value does (a class_type like
// "CLIPTextEncode", a prompt word like "masterpiece"). Exported for unit testing.
export function matchesQuery(
  value: unknown,
  query: string,
  key?: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (key !== undefined && key.toLowerCase().includes(q)) return true;
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return String(value).toLowerCase().includes(q);
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.some(([k, v]) => matchesQuery(v, q, k));
}

// Flatten every leaf whose key or value contains the term into pinnable rows,
// so matches can be surfaced at the top of the panel (no scrolling to find the
// buried node). Each row carries its rooted dot-path — the same path clicking the
// tree leaf would pin. Exported for unit testing.
export type GraphMatch = { path: string; value: unknown };

export function collectMatches(
  value: unknown,
  query: string,
  path = "",
  key = "",
): GraphMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  if (value === null || typeof value !== "object") {
    const keyHit = key.toLowerCase().includes(q);
    const valHit = value != null && String(value).toLowerCase().includes(q);
    return keyHit || valHit ? [{ path, value }] : [];
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([k, v]) =>
    collectMatches(v, q, path ? `${path}.${k}` : k, k),
  );
}

const HIT = "bg-yellow-500/25 text-yellow-100 rounded px-0.5";

// A clickable JSON tree: leaves pin their dot-path into the active field.
// `query` highlights matching keys/values and force-opens the branches that
// contain a match (the tree is collapsed at depth >= 2), so a search reveals the
// whole matching node — its id *and* its class_type stay in view, never pruned.
// Exported for unit testing the path construction (the load-bearing, silent-on-
// failure interaction: click leaf -> correct dot-path).
export function JsonTree({
  value,
  path,
  onPin,
  depth = 0,
  query = "",
}: {
  value: unknown;
  path: string;
  onPin: (path: string) => void;
  depth?: number;
  query?: string;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value && typeof value === "object";
  const hasQuery = query.trim().length > 0;

  if (!isObj) {
    const valHit = hasQuery && matchesQuery(value, query);
    return (
      <button
        onClick={() => onPin(path)}
        data-graph-path={path}
        className="group inline-flex items-baseline gap-2 text-left hover:bg-brand-500/10 rounded px-1 -mx-1 w-full"
        title={`Pin ${path}`}
      >
        <span className={valHit ? `break-all ${HIT}` : "text-emerald-300 break-all"}>
          {JSON.stringify(value)}
        </span>
        <span className="text-2xs text-faint group-hover:text-brand-300 ml-auto shrink-0">
          {path}
        </span>
      </button>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

  return (
    <div className={depth === 0 ? "" : "pl-3 border-l border-neutral-800"}>
      {entries.map(([k, v]) => {
        const childPath = path ? `${path}.${k}` : k;
        const leaf = !v || typeof v !== "object";
        const keyHit = hasQuery && k.toLowerCase().includes(query.trim().toLowerCase());
        const keyCls = keyHit ? HIT : "text-sky-300";
        // Force a branch open when it (or a descendant) matches the search.
        const childOpen = open || (hasQuery && matchesQuery(v, query, k));
        return (
          <div key={k} className="py-0.5">
            {leaf ? (
              <div className="flex items-baseline gap-2">
                <span className={`shrink-0 ${keyCls}`}>{k}:</span>
                <JsonTree
                  value={v}
                  path={childPath}
                  onPin={onPin}
                  depth={depth + 1}
                  query={query}
                />
              </div>
            ) : (
              <div>
                <button
                  onClick={() => setOpen((o) => !o)}
                  className={`hover:text-sky-200 ${keyCls}`}
                >
                  {childOpen ? "▾" : "▸"} {k}
                </button>
                {childOpen && (
                  <JsonTree
                    value={v}
                    path={childPath}
                    onPin={onPin}
                    depth={depth + 1}
                    query={query}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function RulesPage() {
  const { push } = useToast();
  const [sigs, setSigs] = useState<SignatureRow[]>([]);
  const [activeField, setActiveField] = useState<RuleField>("prompt");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Search *within* the selected sample graph — find a node by id, class_type, or
  // a prompt word and see where it lives so its dot-path can be pinned.
  const [graphQuery, setGraphQuery] = useState("");

  const loadSignatures = useCallback(() => {
    fetchSignatures()
      .then(setSigs)
      .catch((e) => push(`Failed to load signatures: ${String(e)}`, "error"));
  }, [push]);

  useEffect(() => loadSignatures(), [loadSignatures]);

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

  // Deep link from a specific image (Full View "Edit rule" button) —
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

  const pinPath = useCallback(
    (path: string) => {
      session.pinPath(activeField, path);
      push(`Pinned ${path} → ${FIELD_LABEL[activeField]}`, "info");
    },
    [session, activeField, push],
  );

  const runPreview = useCallback(async () => {
    if (!selected) return;
    const sig = selected.workflow_sig;
    setPreviewBusy(true);
    try {
      const res = await previewRuleset(selected.sample_image_id, fields);
      // Ignore a preview that lands after the user switched signature.
      if (selectedSigRef.current === sig) setPreview(res);
    } catch (e) {
      push(`Preview failed: ${String(e)}`, "error");
    } finally {
      setPreviewBusy(false);
    }
  }, [selected, fields, push]);

  const previewGen = preview?.gen;
  const firedByField = useMemo(() => preview?.paths ?? {}, [preview]);

  // Matches surfaced at the top of the graph panel so a hit deep in a large graph
  // is reachable instead of scrolling to find it.
  const matches = useMemo(
    () => (graph && graphQuery.trim() ? collectMatches(graph, graphQuery) : []),
    [graph, graphQuery],
  );

  // Scroll the matched leaf into view so its surrounding node (class_type,
  // sibling inputs) is readable — the user picks the right hit before pinning.
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

      {sigs.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No workflow signatures yet"
          description="Scan a library of ComfyUI images first. Each distinct workflow shape appears here for mapping."
        />
      ) : (
        <div className="grid grid-cols-12 gap-4">
          {/* Workflow picker. A workflow is identified by its node types, so
              it's named by the nodes that set it apart and shown with a
              sample image; the hash is only a tooltip. */}
          <div className="col-span-12 lg:col-span-3 space-y-1.5">
            <div className="px-1 pb-1 text-xs font-medium text-muted">Workflows</div>
            {sigs.map((s) => {
              const on = selected?.workflow_sig === s.workflow_sig;
              return (
                <button
                  key={s.workflow_sig}
                  onClick={() => void selectSig(s)}
                  title={`Workflow ${s.workflow_sig}`}
                  aria-current={on ? "true" : undefined}
                  className={`w-full text-left p-2 rounded-lg border flex items-center gap-3 transition-colors ${
                    on
                      ? "bg-raised border-brand-500/60"
                      : "bg-surface border-line hover:border-line-strong"
                  }`}
                >
                  {s.sample_thumb_url ? (
                    <img
                      src={s.sample_thumb_url}
                      alt=""
                      loading="lazy"
                      className="w-10 h-10 rounded-md object-cover shrink-0 bg-raised"
                    />
                  ) : (
                    <span className="w-10 h-10 rounded-md shrink-0 bg-raised inline-flex items-center justify-center text-faint">
                      <Workflow size={16} />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-neutral-100 truncate">
                      {signatureTitle(s)}
                    </span>
                    <span className="flex items-center gap-1.5 mt-0.5 text-xs text-faint tabular-nums">
                      {s.count} {s.count === 1 ? "image" : "images"}
                      {s.node_count ? <> · {s.node_count} nodes</> : null}
                      {s.needs_mapping > 0 ? (
                        <span className="ml-auto text-amber-300" title="Images whose prompt couldn't be found">
                          {s.needs_mapping} unmapped
                        </span>
                      ) : s.has_ruleset ? (
                        <span className="ml-auto text-brand-300">Rules set</span>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {!selected ? (
            <div className="col-span-12 lg:col-span-9 rounded-xl border border-dashed border-line">
              <EmptyState
                compact
                icon={MousePointerClick}
                title="Pick a workflow"
                description="Choose one on the left to see its graph. Click any value in it to say which field it is — say, the node that holds your positive prompt."
              />
            </div>
          ) : (
            <div className="col-span-12 lg:col-span-9 grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Field editors + actions */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button onClick={() => void runPreview()} disabled={busy}>
                    <Play size={14} /> Preview
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void save()}
                    disabled={busy || loading || loadFailed}
                    title={loadFailed ? "Ruleset didn't load — click the signature to retry" : undefined}
                  >
                    <Save size={14} /> Save
                    {isDirty && (
                      <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    )}
                  </Button>
                  <Button variant="ghost" onClick={() => void remove()} disabled={busy}>
                    <Trash2 size={14} /> Reset to built-in
                  </Button>
                  {isDirty && (
                    <span className="flex items-center gap-1 text-2xs text-amber-400">
                      <AlertTriangle size={12} /> Unsaved changes
                    </span>
                  )}
                </div>

                {RULE_FIELDS.map((field) => (
                  <div
                    key={field}
                    className={`rounded-lg border p-2.5 ${
                      activeField === field
                        ? "border-brand-500/60 bg-brand-500/5"
                        : "border-line bg-surface"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <button
                        onClick={() => setActiveField(field)}
                        className="text-sm font-medium inline-flex items-center gap-1.5"
                        title="Make this the target for tree clicks"
                      >
                        <Plus
                          size={13}
                          className={
                            activeField === field
                              ? "text-brand-300"
                              : "text-faint"
                          }
                        />
                        {FIELD_LABEL[field]}
                      </button>
                      {previewGen != null && (
                        <span className="text-2xs text-neutral-400 truncate max-w-[55%]">
                          → {String((previewGen as Record<string, unknown>)[field] ?? "—")}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(fields[field] || []).map((p) => {
                        const fired = (firedByField[field] || []).find(
                          (r) => r.path === p,
                        );
                        const ok = fired && fired.coerced != null;
                        return (
                          <span
                            key={p}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-mono border ${
                              preview
                                ? ok
                                  ? "bg-brand-500/15 border-brand-500/50 text-brand-100"
                                  : "bg-raised border-line-strong text-muted"
                                : "bg-raised border-line-strong"
                            }`}
                            title={
                              fired ? `resolved: ${String(fired.coerced)}` : undefined
                            }
                          >
                            {p}
                            <button
                              onClick={() => removePath(field, p)}
                              className="hover:text-white"
                              aria-label={`Remove ${p}`}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        );
                      })}
                      {(fields[field] || []).length === 0 && (
                        <span className="text-2xs text-faint">
                          Built-in — click a value in the graph to override
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Raw graph tree */}
              <div
                ref={graphScrollRef}
                className="rounded-lg border border-line bg-canvas p-3 overflow-auto max-h-[70vh]"
              >
                {/* Sticky header: stays put while the tree scrolls, so the search
                    box and the surfaced matches are always reachable. */}
                <div className="sticky -top-3 -mx-3 -mt-3 px-3 pt-3 pb-2 bg-canvas z-10 border-b border-line">
                  <div className="text-xs text-neutral-400 mb-2">
                    Sample graph — click a value to pin it to{" "}
                    <span className="text-brand-300">{FIELD_LABEL[activeField]}</span>
                  </div>
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none"
                    />
                    <input
                      type="search"
                      value={graphQuery}
                      onChange={(e) => setGraphQuery(e.target.value)}
                      placeholder="Find a node — id, class_type, or prompt word (e.g. masterpiece)"
                      className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-surface border border-line text-xs placeholder:text-faint focus:border-brand-500/70 focus:outline-none"
                    />
                  </div>
                  {graphQuery.trim() && (
                    <div className="mt-2">
                      <div className="text-2xs text-neutral-400 mb-1">
                        {matches.length === 0
                          ? "No matches in this graph"
                          : `${matches.length} match${matches.length > 1 ? "es" : ""} — click to jump to it; + pins to ${FIELD_LABEL[activeField]}`}
                      </div>
                      <div className="max-h-40 overflow-auto space-y-0.5">
                        {matches.slice(0, 100).map((m) => (
                          <div
                            key={m.path}
                            className="flex items-baseline gap-1 rounded hover:bg-brand-500/10"
                          >
                            <button
                              onClick={() => revealPath(m.path)}
                              title={`Jump to ${m.path}`}
                              className="flex-1 min-w-0 text-left flex items-baseline gap-2 px-1.5 py-1 font-mono text-2xs"
                            >
                              <span className="text-brand-300 shrink-0">{m.path}</span>
                              <span className="text-neutral-400 truncate">
                                {String(m.value)}
                              </span>
                            </button>
                            <button
                              onClick={() => pinPath(m.path)}
                              title={`Pin ${m.path} → ${FIELD_LABEL[activeField]}`}
                              aria-label={`Pin ${m.path}`}
                              className="shrink-0 px-1.5 py-1 text-faint hover:text-brand-300"
                            >
                              <Plus size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {graph ? (
                  <div className="font-mono text-xs leading-relaxed">
                    <JsonTree
                      value={graph}
                      path=""
                      onPin={pinPath}
                      query={graphQuery}
                    />
                  </div>
                ) : (
                  <div className="text-faint text-sm">Loading graph…</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      </PageBody>
    </>
  );
}
