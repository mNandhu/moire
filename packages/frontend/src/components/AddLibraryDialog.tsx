import { useMemo, useRef, useState } from "react";
import { AlertTriangle, FolderOpen, FolderTree, Plus, ScanSearch } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Input, Field } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { Spinner } from "./ui/Skeleton";
import { api } from "../lib/api";
import { cn } from "../lib/cn";
import {
  defaultSelected,
  discoverLibraries,
  formatCount,
  isSelectable,
  parsePathList,
  type DiscoverSource,
  type LibraryCandidate,
} from "../lib/libraryPlan";

/** FastAPI errors arrive as `{"detail": "..."}` or a 422 list; show the words. */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const d = JSON.parse(raw)?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => x?.msg ?? String(x)).join("; ");
  } catch {
    /* not JSON; use as-is */
  }
  return raw;
}

const STATUS_BADGE: Record<
  LibraryCandidate["status"],
  { label: string; tone: "neutral" | "warning" | "danger" | "info" } | null
> = {
  new: null,
  registered: { label: "Already added", tone: "neutral" },
  overlap: { label: "Overlaps", tone: "warning" },
  empty: { label: "No images", tone: "neutral" },
};

/**
 * Add one or many libraries. Two steps: the user lists folders (optionally
 * splitting each into one library per subfolder) and previews; the dry run
 * shows exactly which libraries would be created, with image counts and
 * conflicts, and nothing is written until they confirm the ticked rows.
 */
export function AddLibraryDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after at least one library was added. */
  onAdded: (summary: { added: number; failed: string[] }) => void;
}) {
  const [text, setText] = useState("");
  const [split, setSplit] = useState(false);
  const [sources, setSources] = useState<DiscoverSource[] | null>(null);
  // The inputs the current preview was made from; editing either makes it stale.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paths = useMemo(() => parsePathList(text), [text]);
  const inputKey = JSON.stringify([paths, split]);
  const stale = sources !== null && previewKey !== inputKey;

  const candidates = useMemo(
    () => (sources ?? []).flatMap((s) => s.candidates),
    [sources],
  );
  const chosen = candidates.filter((c) => selected.has(c.path));
  const chosenImages = chosen.reduce((n, c) => n + c.image_count, 0);
  const anyCapped = chosen.some((c) => c.count_capped);

  // Bumped on close: a preview still in flight when the dialog closes must not
  // repopulate the next session.
  const session = useRef(0);

  const reset = () => {
    session.current++;
    setLoading(false);
    setText("");
    setSplit(false);
    setSources(null);
    setPreviewKey(null);
    setSelected(new Set());
    setNames({});
    setError(null);
  };

  const close = () => {
    if (adding) return;
    reset();
    onClose();
  };

  const preview = async () => {
    if (!paths.length) return;
    const mine = session.current;
    setLoading(true);
    setError(null);
    try {
      const res = await discoverLibraries(paths, split);
      if (session.current !== mine) return;
      setSources(res.sources);
      setPreviewKey(inputKey);
      const cs = res.sources.flatMap((s) => s.candidates);
      setSelected(new Set(cs.filter(defaultSelected).map((c) => c.path)));
      setNames(Object.fromEntries(cs.map((c) => [c.path, c.name])));
    } catch (e) {
      if (session.current === mine) setError(errorText(e));
    } finally {
      if (session.current === mine) setLoading(false);
    }
  };

  const canAdd = !!sources && !stale && chosen.length > 0 && !adding;

  const add = async () => {
    // The Ctrl+Enter shortcut reaches here too: never run two adds at once
    // (concurrent POSTs for one path can both miss the backend's dedupe), and
    // never "add" an empty selection, which would just close the dialog.
    if (!canAdd) return;
    setAdding(true);
    const failed: string[] = [];
    const failedPaths = new Set<string>();
    let added = 0;
    // Sequential: each POST is cheap (the scan runs in the background and the
    // backend queues concurrent scans), and per-row errors stay attributable.
    for (const c of chosen) {
      try {
        await api(`/api/v1/libraries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: c.path, name: names[c.path]?.trim() || undefined }),
        });
        added++;
      } catch (e) {
        failed.push(`${c.path}: ${errorText(e)}`);
        failedPaths.add(c.path);
      }
    }
    setAdding(false);
    if (added) onAdded({ added, failed });
    if (failed.length) {
      setError(`${failed.length} failed:\n${failed.join("\n")}`);
      // Keep only the rows that failed so a retry doesn't double-submit.
      setSelected(failedPaths);
      return;
    }
    reset();
    onClose();
  };

  const toggle = (path: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(path);
      else n.delete(path);
      return n;
    });

  return (
    <Dialog
      open={open}
      onClose={close}
      title={
        <span className="flex items-center gap-2">
          <FolderOpen size={18} className="text-brand-300" /> Add libraries
        </span>
      }
      description="List one or more folders. Preview shows exactly what will be added before anything is indexed."
      className="max-w-3xl"
      footer={
        <>
          <span className="mr-auto self-center text-xs text-neutral-400 tabular-nums">
            {sources && !stale && chosen.length > 0 &&
              `${chosen.length} librar${chosen.length === 1 ? "y" : "ies"} · ${chosenImages.toLocaleString()}${anyCapped ? "+" : ""} images`}
          </span>
          <Button onClick={close} disabled={adding}>
            Cancel
          </Button>
          {sources && !stale ? (
            <Button variant="primary" onClick={() => void add()} disabled={!canAdd}>
              {adding ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={16} />}
              {adding
                ? "Adding…"
                : `Add ${chosen.length || ""} librar${chosen.length === 1 ? "y" : "ies"}`}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void preview()} disabled={!paths.length || loading}>
              {loading ? <Spinner className="h-3.5 w-3.5" /> : <ScanSearch size={16} />}
              {loading ? "Scanning folders…" : "Preview"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Folders"
          htmlFor="add_lib_paths"
          hint="Absolute paths, one per line, e.g. D:/images or /mnt/g/images."
        >
          <textarea
            id="add_lib_paths"
            rows={Math.min(6, Math.max(2, paths.length + 1))}
            placeholder={"D:/images/portraits\nD:/images/landscapes"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={adding}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (adding || loading) return;
                if (sources && !stale) void add();
                else void preview();
              }
            }}
            className="w-full resize-y rounded-lg bg-neutral-950/70 border border-neutral-800 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-faint focus:border-brand-600/60 transition-colors"
          />
        </Field>

        <Checkbox
          checked={split}
          onChange={setSplit}
          label={
            <span className="inline-flex items-center gap-1.5">
              <FolderTree size={14} className="text-neutral-400" /> Each subfolder becomes its own library
            </span>
          }
          hint="Only the first level of subfolders is split; deeper folders are indexed inside their parent."
        />

        {error && (
          <div className="whitespace-pre-wrap rounded-lg border border-red-800 bg-red-900/30 p-3 text-sm text-red-200">
            {error}
          </div>
        )}

        {sources && (
          <div className={cn("space-y-3 transition-opacity", stale && "opacity-50")}>
            <div className="flex items-center justify-between text-xs text-neutral-400">
              <span className="font-medium uppercase tracking-wide">Preview</span>
              {stale && (
                <span className="text-amber-300">Folders changed. Preview again</span>
              )}
            </div>
            <div className="max-h-[45vh] overflow-auto space-y-3 pr-1">
              {sources.map((s) => (
                <SourceBlock
                  key={s.path}
                  source={s}
                  split={split}
                  selected={selected}
                  names={names}
                  disabled={stale || adding}
                  onToggle={toggle}
                  onRename={(p, n) => setNames((m) => ({ ...m, [p]: n }))}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function SourceBlock({
  source: s,
  split,
  selected,
  names,
  disabled,
  onToggle,
  onRename,
}: {
  source: DiscoverSource;
  split: boolean;
  selected: Set<string>;
  names: Record<string, string>;
  disabled: boolean;
  onToggle: (path: string, on: boolean) => void;
  onRename: (path: string, name: string) => void;
}) {
  const selectable = s.candidates.filter(isSelectable);
  const allOn = selectable.length > 0 && selectable.every((c) => selected.has(c.path));
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-neutral-800">
        <span className="font-mono text-xs text-neutral-200 truncate min-w-0 flex-1" title={s.path}>
          {s.path}
        </span>
        {split && s.ok && !s.fell_back_to_root && (
          <Badge>{s.subdir_count} subfolders</Badge>
        )}
        {split && selectable.length > 1 && (
          <button
            type="button"
            disabled={disabled}
            className="text-xs text-brand-300 hover:text-brand-200 disabled:opacity-50"
            onClick={() => selectable.forEach((c) => onToggle(c.path, !allOn))}
          >
            {allOn ? "Select none" : "Select all"}
          </button>
        )}
      </div>

      {!s.ok && (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-red-300">
          <AlertTriangle size={14} /> {s.error}
        </div>
      )}
      {s.fell_back_to_root && (
        <div className="px-3 pt-2 text-xs text-muted">
          No subfolders here. The folder itself will be added as one library.
        </div>
      )}
      {split && !s.fell_back_to_root && s.loose_image_count > 0 && (
        <div className="flex items-center gap-1.5 px-3 pt-2 text-xs text-amber-300">
          <AlertTriangle size={12} />
          {s.loose_image_count.toLocaleString()} image
          {s.loose_image_count === 1 ? "" : "s"} directly in this folder won't be in any
          subfolder library.
        </div>
      )}

      <ul className="divide-y divide-neutral-800/70">
        {s.candidates.map((c) => {
          const can = isSelectable(c);
          const badge = STATUS_BADGE[c.status];
          return (
            <li
              key={c.path}
              className={cn("flex items-center gap-3 px-3 py-2", !can && "opacity-60")}
            >
              <Checkbox
                checked={selected.has(c.path)}
                onChange={(on) => onToggle(c.path, on)}
                disabled={!can || disabled}
              />
              <div className="min-w-0 flex-1">
                <Input
                  aria-label={`Name for ${c.path}`}
                  value={names[c.path] ?? c.name}
                  onChange={(e) => onRename(c.path, e.target.value)}
                  disabled={!can || disabled}
                  className="h-7 py-1 text-sm"
                />
                <div
                  className="mt-0.5 truncate font-mono text-2xs text-faint"
                  title={c.note ? `${c.note}${c.conflict_path ? `: ${c.conflict_path}` : ""}` : c.path}
                >
                  {c.path}
                  {c.note && c.conflict_path && c.status === "overlap" && (
                    <span className="text-amber-400/90"> · {c.note.toLowerCase()} ({c.conflict_path})</span>
                  )}
                </div>
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-neutral-400 tabular-nums">
                {formatCount(c)}
              </span>
              <span className="flex shrink-0 gap-1">
                {c.hidden && <Badge>Hidden</Badge>}
                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
