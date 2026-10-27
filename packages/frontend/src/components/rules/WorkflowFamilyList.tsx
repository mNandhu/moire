import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, FileJson, FolderOpen, Images, Pencil, Search, Upload, Workflow } from "lucide-react";
import { useLocalPref, KEY_SET } from "../../hooks/useLocalPref";
import { useToast } from "../Toasts";
import { Input } from "../ui/Input";
import { DropdownMenu } from "../ui/DropdownMenu";
import { InGenerateBadge } from "../generate/InGenerate";
import { errorText } from "../../lib/api";
import { filesFromDrop } from "../../lib/dropFiles";
import type { Generator } from "../../lib/generate";
import { galleryHref } from "../../lib/imageFilter";
import type { SignatureRow } from "../../lib/rules";
import {
  filterFamilies,
  importSummary,
  putWorkflowName,
  readWorkflowFiles,
  type WorkflowFamily,
} from "../../lib/workflows";

const COLLAPSED_KEY = "rules:collapsedWorkflows";
const NO_KEYS: Set<string> = new Set();
const isJson = (name: string) => /\.json$/i.test(name);
// Collapse key for the group of images with no workflow id.
const OTHER_FAMILY = "__other__";

/**
 * The Rules page's workflow picker: one group per saved workflow (family),
 * with its versions under it, a search, family rename, remembered collapse
 * state, and importing workflow files by drop or the Import menu.
 */
export function WorkflowFamilyList({
  families,
  sigs,
  generators,
  selectedSig,
  onSelect,
  onChanged,
}: {
  families: WorkflowFamily[];
  sigs: SignatureRow[];
  generators: Generator[] | undefined;
  selectedSig: string | null;
  onSelect: (row: SignatureRow) => void;
  /** A rename or import changed the signature list. */
  onChanged: () => void;
}) {
  const { push } = useToast();
  const [wfQuery, setWfQuery] = useState("");
  const wfq = wfQuery.trim().toLowerCase();
  const shownFamilies = useMemo(() => filterFamilies(families, wfQuery), [families, wfQuery]);

  // undefined = not editing; a family id = that family's name is open.
  const [editingFamily, setEditingFamily] = useState<string | null | undefined>();
  const [nameDraft, setNameDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Collapsed workflow groups, remembered per browser (a view preference, so
  // localStorage is enough; it may be unavailable, hence the try/catch).
  const [collapsed, setCollapsed] = useLocalPref<Set<string>>(COLLAPSED_KEY, NO_KEYS, KEY_SET);
  const setFamilyCollapsed = useCallback(
    (key: string, value: boolean) => {
      setCollapsed((prev) => {
        if (prev.has(key) === value) return prev;
        const next = new Set(prev);
        if (value) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [setCollapsed],
  );

  const renameFamily = useCallback(
    async (id: string, name: string) => {
      setEditingFamily(undefined);
      const current = sigs.find((s) => s.workflow_id === id)?.workflow_name ?? "";
      if (name.trim() === current) return;
      try {
        await putWorkflowName(id, name);
        onChanged();
      } catch (e) {
        push(`Rename failed: ${errorText(e)}`, "error");
      }
    },
    [sigs, onChanged, push],
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
      try {
        const { parsed, imported, known } = await readWorkflowFiles(picked);
        if (!parsed.length) {
          push("No ComfyUI workflow files found (use the saved .json, not an API export)", "error");
          return;
        }
        const skipped = picked.length - parsed.length;
        onChanged();
        push(importSummary({ imported, known, skipped }), known ? "success" : "info");
      } catch (e) {
        push(`Import failed: ${errorText(e)}`, "error");
      }
    },
    [onChanged, push],
  );

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

  return (
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
                    to={galleryHref({ workflow: fam.id })}
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
            const on = selectedSig === s.workflow_sig;
            return (
              <button
                key={s.workflow_sig}
                onClick={() => onSelect(s)}
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
  );
}
