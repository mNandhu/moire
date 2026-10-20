import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
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
  Pencil,
  Images,
  Upload,
  ChevronRight,
  FileJson,
  FolderOpen,
  Wand2,
} from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Button, ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";
import { useToast } from "../components/Toasts";
import { useConfirm } from "../components/ConfirmDialog";
import {
  RULE_FIELDS,
  type RuleField,
  type SignatureRow,
  type PreviewResult,
  type GenMeta,
  fetchSignatures,
  previewRuleset,
} from "../lib/gen";
import { fetchImage } from "../lib/imageFilter";
import {
  groupWorkflows,
  importWorkflowFiles,
  parseWorkflowFile,
  putWorkflowName,
} from "../lib/workflows";
import { Input } from "../components/ui/Input";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { filesFromDrop } from "../lib/dropFiles";
import { useGenerators } from "../lib/generate";
import { InGenerateBadge, generatorFor } from "../components/generate/InGenerate";

const COLLAPSED_KEY = "rules:collapsedWorkflows";
const isJson = (name: string) => /\.json$/i.test(name);
// Collapse key for the group of images with no workflow id.
const OTHER_FAMILY = "__other__";

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
// buried node). Each row carries its rooted dot-path, the same path clicking the
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
// whole matching node: its id *and* its class_type stay in view, never pruned.
// `marks` labels leaves by path (where the prompt was guessed from) and keeps
// the branches down to them open, so they're visible without searching.
// Exported for unit testing the path construction (the load-bearing, silent-on-
// failure interaction: click leaf -> correct dot-path).
export function JsonTree({
  value,
  path,
  onPin,
  depth = 0,
  query = "",
  marks,
}: {
  value: unknown;
  path: string;
  onPin: (path: string) => void;
  depth?: number;
  query?: string;
  marks?: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isObj = value && typeof value === "object";
  const hasQuery = query.trim().length > 0;

  if (!isObj) {
    const valHit = hasQuery && matchesQuery(value, query);
    const mark = marks?.get(path);
    return (
      <button
        onClick={() => onPin(path)}
        data-graph-path={path}
        className={`group inline-flex items-baseline gap-2 text-left hover:bg-brand-500/10 rounded px-1 -mx-1 w-full ${
          mark ? "ring-1 ring-amber-400/40" : ""
        }`}
        title={`Pin ${path}`}
      >
        <span className={valHit ? `break-all ${HIT}` : "text-emerald-300 break-all"}>
          {JSON.stringify(value)}
        </span>
        {mark && (
          <span className="shrink-0 text-2xs font-sans px-1.5 rounded-md border border-amber-400/30 text-amber-300">
            {mark}
          </span>
        )}
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
        const childOpen =
          open ||
          (hasQuery && matchesQuery(v, query, k)) ||
          (!!marks && [...marks.keys()].some((p) => p.startsWith(`${childPath}.`)));
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
                  marks={marks}
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
                    marks={marks}
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

// An unpinned field the sample only has by keyword guessing: where the text
// came from, a jump to it in the graph, and a one-click pin to make it certain.
function GuessedFrom({
  path,
  onReveal,
  onPin,
}: {
  path: string | null;
  onReveal: (path: string) => void;
  onPin: (path: string) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 text-2xs text-amber-300">
      <span className="shrink-0 px-1.5 rounded-md border border-amber-400/30">Guessed</span>
      {path ? (
        <>
          <button
            type="button"
            onClick={() => onReveal(path)}
            className="font-mono truncate hover:text-amber-200"
            title="Show it in the graph"
          >
            {path}
          </button>
          <button
            type="button"
            onClick={() => onPin(path)}
            className="shrink-0 inline-flex items-center gap-0.5 text-brand-300 hover:text-brand-200"
            title="Pin this value so it's no longer a guess"
          >
            <Plus size={11} /> Pin
          </button>
        </>
      ) : (
        <span className="text-faint">by keyword match</span>
      )}
    </span>
  );
}

export default function RulesPage() {
  const { push } = useToast();
  const [sigs, setSigs] = useState<SignatureRow[]>([]);
  // False until the first fetch answers, so "none yet" never flashes first.
  const [sigsLoaded, setSigsLoaded] = useState(false);
  const [wfQuery, setWfQuery] = useState("");
  const [activeField, setActiveField] = useState<RuleField>("prompt");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // Search *within* the selected sample graph: find a node by id, class_type, or
  // a prompt word and see where it lives so its dot-path can be pinned.
  const [graphQuery, setGraphQuery] = useState("");

  const loadSignatures = useCallback(() => {
    fetchSignatures()
      .then(setSigs)
      .catch((e) => push(`Failed to load signatures: ${String(e)}`, "error"))
      .finally(() => setSigsLoaded(true));
  }, [push]);

  useEffect(() => loadSignatures(), [loadSignatures]);

  const families = useMemo(() => groupWorkflows(sigs), [sigs]);
  // Workflows set up to run in Generate, to mark their families and versions.
  const { data: generators } = useGenerators();
  const wfq = wfQuery.trim().toLowerCase();
  // The picker's search: versions matching by title, note, file or signature;
  // a workflow whose own name matches keeps all its versions.
  const shownFamilies = useMemo(() => {
    if (!wfq) return families;
    return families
      .map((f) =>
        f.name.toLowerCase().includes(wfq)
          ? f
          : {
              ...f,
              versions: f.versions.filter((v) =>
                [v.title, v.note, v.file, v.row.workflow_sig].some((x) => x?.toLowerCase().includes(wfq)),
              ),
            },
      )
      .filter((f) => f.versions.length);
  }, [families, wfq]);
  // undefined = not editing; a family id = that family's name is open.
  const [editingFamily, setEditingFamily] = useState<string | null | undefined>();
  const [nameDraft, setNameDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Collapsed workflow groups, remembered per browser (a view preference, so
  // localStorage is enough; it may be unavailable, hence the try/catch).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const setFamilyCollapsed = useCallback((key: string, value: boolean) => {
    setCollapsed((prev) => {
      if (prev.has(key) === value) return prev;
      const next = new Set(prev);
      if (value) next.add(key);
      else next.delete(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Storage blocked: the preference just won't survive a reload.
      }
      return next;
    });
  }, []);

  const renameFamily = useCallback(
    async (id: string, name: string) => {
      setEditingFamily(undefined);
      const current = sigs.find((s) => s.workflow_id === id)?.workflow_name ?? "";
      if (name.trim() === current) return;
      try {
        await putWorkflowName(id, name);
        loadSignatures();
      } catch (e) {
        push(`Rename failed: ${String(e)}`, "error");
      }
    },
    [sigs, loadSignatures, push],
  );

  // Read dropped/picked workflow files in the browser and send only what the
  // match needs (id, filename, node types).
  const importFiles = useCallback(
    async (list: FileList | File[] | null) => {
      const picked = Array.from(list ?? []).filter((f) => isJson(f.name));
      if (!picked.length) {
        if (list && Array.from(list).length) push("No .json files in that selection", "info");
        return;
      }
      const parsed = (
        await Promise.all(picked.map(async (f) => parseWorkflowFile(await f.text(), f.name)))
      ).filter((w): w is NonNullable<typeof w> => w !== null);
      const skipped = picked.length - parsed.length;
      if (!parsed.length) {
        push("No ComfyUI workflow files found (use the saved .json, not an API export)", "error");
        return;
      }
      try {
        const { imported, known } = await importWorkflowFiles(parsed);
        loadSignatures();
        push(
          `Imported ${imported} ${imported === 1 ? "file" : "files"}` +
            (known
              ? ` · ${known} ${known === 1 ? "workflow" : "workflows"} in your library`
              : ". None belong to workflows in your library") +
            (skipped ? ` · ${skipped} skipped (not a workflow)` : ""),
          known ? "success" : "info",
        );
      } catch (e) {
        push(`Import failed: ${String(e)}`, "error");
      }
    },
    [loadSignatures, push],
  );

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

  // A selected version is never hidden: picking one (or arriving from an
  // image's "Edit rule" link) opens its group.
  // Keyed on the selection only (families read through a ref), so a list
  // reload after saving doesn't reopen a group the user just closed.
  const familiesRef = useRef(families);
  familiesRef.current = families;
  useEffect(() => {
    if (!selectedSig) return;
    const fam = familiesRef.current.find((f) =>
      f.versions.some((v) => v.row.workflow_sig === selectedSig),
    );
    if (fam) setFamilyCollapsed(fam.id ?? OTHER_FAMILY, false);
  }, [selectedSig, setFamilyCollapsed]);

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
  const guessPath = (field: RuleField): string | null | undefined =>
    currentGen?.guessed?.includes(field as "prompt" | "negative")
      ? (currentGen.guess_paths?.[field as "prompt" | "negative"] ?? null)
      : undefined;
  const guessMarks = useMemo(() => {
    const m = new Map<string, string>();
    for (const field of ["prompt", "negative"] as const) {
      if ((fields[field] || []).length > 0) continue;
      const p = currentGen?.guessed?.includes(field) ? currentGen.guess_paths?.[field] : null;
      if (p) m.set(p, `Guessed ${FIELD_LABEL[field].toLowerCase()}`);
    }
    return m;
  }, [currentGen, fields]);
  const firedByField = useMemo(() => preview?.paths ?? {}, [preview]);

  // Matches surfaced at the top of the graph panel so a hit deep in a large graph
  // is reachable instead of scrolling to find it.
  const matches = useMemo(
    () => (graph && graphQuery.trim() ? collectMatches(graph, graphQuery) : []),
    [graph, graphQuery],
  );

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
          <div
            className={`col-span-12 lg:col-span-3 space-y-4 rounded-xl transition-colors lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:pr-1 ${
              dragging ? "outline-dashed outline-2 outline-brand-500/60 outline-offset-4" : ""
            }`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              // Folders too: filesFromDrop walks into them.
              void filesFromDrop(e.dataTransfer, isJson).then(importFiles);
            }}
          >
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs font-medium text-muted">Workflows</span>
              {/* Name versions after your saved ComfyUI workflows. Only each
                  file's id, name and node list are read; files stay local. */}
              <DropdownMenu
                size="sm"
                label={
                  <>
                    <Upload size={13} /> Import
                  </>
                }
                items={[
                  {
                    label: "Workflow files…",
                    icon: <FileJson size={15} />,
                    onClick: () => fileInputRef.current?.click(),
                  },
                  {
                    label: "A folder…",
                    icon: <FolderOpen size={15} />,
                    onClick: () => folderInputRef.current?.click(),
                  },
                ]}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {/* webkitdirectory picks a whole folder, subfolders included
                  (ComfyUI keeps workflows in user/default/workflows). */}
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                {...{ webkitdirectory: "" }}
                onChange={(e) => {
                  void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
            {(families.length > 3 || wfq) && (
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  className="h-8 pl-8 text-sm"
                  value={wfQuery}
                  placeholder="Find a workflow"
                  aria-label="Find a workflow"
                  onChange={(e) => setWfQuery(e.target.value)}
                />
              </div>
            )}
            {wfq && shownFamilies.length === 0 && <p className="px-1 text-sm text-faint">No match</p>}
            {shownFamilies.map((fam) => {
              const famKey = fam.id ?? OTHER_FAMILY;
              const open = !!wfq || !collapsed.has(famKey);
              const listId = `workflow-versions-${famKey}`;
              return (
              <div key={famKey} className="space-y-1.5">
                <div className="flex items-center gap-2 px-1 min-h-7">
                  {editingFamily === fam.id && fam.id ? (
                    <form
                      className="flex-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void renameFamily(fam.id!, nameDraft);
                      }}
                    >
                      <Input
                        autoFocus
                        className="h-7 text-sm"
                        value={nameDraft}
                        placeholder="Workflow name"
                        aria-label="Workflow name"
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={() => void renameFamily(fam.id!, nameDraft)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setEditingFamily(undefined);
                        }}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setFamilyCollapsed(famKey, open)}
                        aria-expanded={open}
                        aria-controls={listId}
                        className="flex items-center gap-1 min-w-0 -ml-1 pl-0.5 pr-1 py-0.5 rounded hover:bg-raised"
                        title={fam.id ? `${fam.name}\nWorkflow id ${fam.id}` : fam.name}
                      >
                        <ChevronRight
                          size={14}
                          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <span
                          className={`truncate text-sm font-semibold ${
                            fam.unnamed ? "text-muted" : "text-neutral-100"
                          }`}
                        >
                          {fam.name}
                        </span>
                      </button>
                      {fam.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingFamily(fam.id);
                            setNameDraft(fam.unnamed ? "" : fam.name);
                          }}
                          className="shrink-0 p-1 rounded text-faint hover:text-neutral-100 hover:bg-raised"
                          aria-label={`Rename ${fam.name}`}
                          title="Rename"
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      {fam.id && (
                        <Link
                          to={`/?workflow=${encodeURIComponent(fam.id)}`}
                          className="shrink-0 p-1 rounded text-faint hover:text-neutral-100 hover:bg-raised"
                          aria-label={`Show images from every version of ${fam.name} in the gallery`}
                          title="Show every version's images in the gallery"
                        >
                          <Images size={12} />
                        </Link>
                      )}
                      {fam.id && (
                        <InGenerateBadge
                          generators={generators}
                          family={fam.id}
                          versions={fam.versions.map((v) => v.row.workflow_sig)}
                        />
                      )}
                      <span className="ml-auto text-2xs text-faint tabular-nums shrink-0">
                        {fam.versions.length} {fam.versions.length === 1 ? "version" : "versions"}
                      </span>
                    </>
                  )}
                </div>
                {open && (
                <div id={listId} className="space-y-1.5">
                {fam.versions.map(({ row: s, title, note, file }) => {
                  const on = selected?.workflow_sig === s.workflow_sig;
                  return (
                    <button
                      key={s.workflow_sig}
                      onClick={() => void selectSig(s)}
                      title={`Signature ${s.workflow_sig}`}
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
                        <span className="block text-sm text-neutral-100 truncate">{title}</span>
                        <span className="flex items-center gap-1.5 mt-0.5 text-xs text-faint tabular-nums min-w-0">
                          <span className="truncate">
                            {[note, file, `${s.count} ${s.count === 1 ? "image" : "images"}`]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          {s.needs_mapping > 0 ? (
                            <span className="ml-auto shrink-0 text-amber-300" title="Images whose prompt couldn't be found">
                              {s.needs_mapping} unmapped
                            </span>
                          ) : s.guessed ? (
                            <span className="ml-auto shrink-0 text-amber-300/80" title="Prompts picked by keyword match; pin the prompt to be certain">
                              {s.guessed} guessed
                            </span>
                          ) : s.has_ruleset ? (
                            <span className="ml-auto shrink-0 text-brand-300">Rules set</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}
                </div>
                )}
              </div>
              );
            })}
          </div>

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
              <div className="space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Button onClick={() => void runPreview()} disabled={busy}>
                    <Play size={14} /> Preview
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void save()}
                    disabled={busy || loading || loadFailed}
                    title={loadFailed ? "Ruleset didn't load. Click the signature to retry" : undefined}
                  >
                    <Save size={14} /> Save
                    {isDirty && (
                      <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                    )}
                  </Button>
                  {/* Nothing to reset without saved pins, and the DELETE would
                      still reproject every image of the signature. */}
                  <Button
                    variant="ghost"
                    onClick={() => void remove()}
                    disabled={busy || !hasRuleset}
                    title={hasRuleset ? undefined : "Already using the built-in extraction"}
                  >
                    <Trash2 size={14} /> Reset to built-in
                  </Button>
                  {isDirty && (
                    <span className="flex items-center gap-1 text-2xs text-amber-400">
                      <AlertTriangle size={12} /> Unsaved changes
                    </span>
                  )}
                  {/* This version's images (the family's are on its header). */}
                  <ButtonLink
                    variant="ghost"
                    className="ml-auto"
                    to={`/?workflow_sig=${encodeURIComponent(selected.workflow_sig)}`}
                    title={`The ${selected.count} ${selected.count === 1 ? "image" : "images"} made with this version`}
                  >
                    <Images size={14} /> Show in gallery
                  </ButtonLink>
                  {(() => {
                    const gen = generatorFor(generators, { sig: selected.workflow_sig });
                    return gen ? (
                      <ButtonLink variant="ghost" to={`/generate?workflow=${encodeURIComponent(gen._id)}`}>
                        <Wand2 size={14} /> Open in Generate
                      </ButtonLink>
                    ) : selected.sample_image_id ? (
                      <ButtonLink
                        variant="ghost"
                        to={`/generate/workflows/new?image=${encodeURIComponent(selected.sample_image_id)}`}
                      >
                        <Wand2 size={14} /> Use in Generate
                      </ButtonLink>
                    ) : null;
                  })()}
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
                          → {String((previewGen as Record<string, unknown>)[field] ?? "none")}
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
                      {(fields[field] || []).length === 0 &&
                        guessPath(field) !== undefined && (
                          <GuessedFrom
                            path={guessPath(field) ?? null}
                            onReveal={revealPath}
                            onPin={(p) => {
                              session.pinPath(field, p);
                              push(`Pinned ${p} → ${FIELD_LABEL[field]}`, "info");
                            }}
                          />
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
                    Sample graph. Click a value to pin it to{" "}
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
                      placeholder="Find a node by id, class_type, or prompt word (e.g. masterpiece)"
                      className="w-full pl-8 pr-2 py-1.5 rounded-lg bg-surface border border-line text-xs placeholder:text-faint focus:border-brand-500/70 focus:outline-none"
                    />
                  </div>
                  {graphQuery.trim() && (
                    <div className="mt-2">
                      <div className="text-2xs text-neutral-400 mb-1">
                        {matches.length === 0
                          ? "No matches in this graph"
                          : `${matches.length} match${matches.length > 1 ? "es" : ""}. Click to jump to it; + pins to ${FIELD_LABEL[activeField]}`}
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
                      marks={guessMarks}
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
