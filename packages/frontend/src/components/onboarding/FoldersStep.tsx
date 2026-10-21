import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { errorText } from "../../lib/api";
import { discoverLibraries, type DiscoverSource } from "../../lib/libraryPlan";
import { cleanPath, pathProblem, plural, sourceProblem, sourceTotals } from "../../lib/onboarding";
import { Group, Help, InlineField, StepHeading, SwitchRow } from "./parts";

/** One folder in the list: what `discover` reported for it, so the counts
 * and the libraries it becomes are known before anything is created. */
export type FolderEntry = { source: DiscoverSource; counting?: boolean };

export function folderSummary(folders: FolderEntry[], split: boolean): string {
  if (!folders.length) return "Not set";
  const totals = folders.map((f) => sourceTotals(f.source));
  const images = totals.reduce((n, t) => n + t.images, 0);
  const capped = totals.some((t) => t.capped);
  const what = split
    ? plural(totals.reduce((n, t) => n + t.libraries, 0), "library", "libraries")
    : plural(folders.length, "folder");
  return `${what} · ${images.toLocaleString()}${capped ? "+" : ""} images`;
}

function rowLabel(f: FolderEntry, split: boolean): string {
  if (f.counting) return "Counting…";
  const t = sourceTotals(f.source);
  const images = t.images === 0 && !t.capped ? "No images yet" : `${t.images.toLocaleString()}${t.capped ? "+" : ""} images`;
  return split ? `${plural(t.libraries, "library", "libraries")} · ${images}` : images;
}

/**
 * Step 1. A path goes in the list only once it has been checked: the full
 * path rule and the list's own clashes here, whether the folder is there by
 * asking the server (`discover`, which also counts its images). A bad path
 * stays in the field with the reason under it, so it can be fixed in place.
 */
export function FoldersStep({
  folders,
  setFolders,
  split,
  onSplit,
  remoteHost,
  locked,
}: {
  folders: FolderEntry[];
  setFolders: (update: (prev: FolderEntry[]) => FolderEntry[]) => void;
  split: boolean;
  onSplit: (on: boolean) => void;
  /** The server's machine name when the browser is on another one. */
  remoteHost: string | null;
  /** While libraries are being created. */
  locked: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const add = async (raw: string) => {
    const paths = raw.split(/\r?\n/).map(cleanPath).filter(Boolean);
    if (!paths.length || checking) return;
    setChecking(true);
    setError(null);
    const listed = folders.map((f) => f.source.path);
    const failed: { path: string; error: string }[] = [];
    for (const path of paths) {
      let problem = pathProblem(path, listed);
      if (!problem) {
        try {
          const { sources } = await discoverLibraries([path], split);
          const s = sources[0];
          // The server's spelling can differ (`..` resolved, trailing
          // slash dropped), so check the list again against it.
          problem = s ? (sourceProblem(s) ?? pathProblem(s.path, listed)) : "Moiré couldn't check that folder.";
          if (!problem && s) {
            listed.push(s.path);
            setFolders((prev) => [...prev, { source: s }]);
          }
        } catch (e) {
          problem = errorText(e);
        }
      }
      if (problem) failed.push({ path, error: problem });
    }
    setChecking(false);
    setValue(failed[0]?.path ?? "");
    setError(
      failed.length
        ? failed[0].error + (failed.length > 1 ? ` ${plural(failed.length - 1, "more path")} also failed.` : "")
        : null,
    );
    inputRef.current?.focus();
  };

  const remove = (path: string) => {
    setFolders((prev) => prev.filter((f) => f.source.path !== path));
    inputRef.current?.focus();
  };

  return (
    <section aria-labelledby="h-folders" className="max-w-[620px] animate-fade-in">
      <StepHeading id="h-folders" title="Image folders">
        Moiré indexes the images in these folders and reads the prompt saved in each one. New images are
        picked up as they're saved.
      </StepHeading>
      <Group>
        <label htmlFor="ob-path" className="mb-1 block font-medium">
          Folder path
        </label>
        <Help id="ob-path-help">
          {remoteHost ? (
            <>
              The full path on <code>{remoteHost}</code>, the computer running Moiré. Subfolders are included.
            </>
          ) : (
            <>
              The full path, such as ComfyUI's <code>output</code> folder. Subfolders are included.
            </>
          )}
        </Help>
        <InlineField
          ref={inputRef}
          id="ob-path"
          autoFocus
          value={value}
          invalid={!!error}
          disabled={locked}
          aria-describedby={error ? "ob-path-help ob-path-error" : "ob-path-help"}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text");
            if (!text.includes("\n")) return;
            e.preventDefault();
            void add(text);
          }}
          onCommit={() => void add(value)}
          action={
            <Button type="submit" size="sm" disabled={checking || locked || !value.trim()}>
              {checking ? "Checking…" : "Add"}
            </Button>
          }
        />
        {error && (
          <p id="ob-path-error" role="alert" className="mt-2 text-[13px] leading-normal text-red-300">
            {error}
          </p>
        )}
        {folders.length > 0 && (
          <ul className="mt-2.5" aria-live="polite">
            {folders.map((f) => (
              <li
                key={f.source.path}
                className="grid animate-fade-in grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3.5 border-b border-line py-2 pl-0.5"
              >
                <span className="truncate font-mono text-[13px]" title={f.source.path}>
                  {f.source.path}
                </span>
                <span className="whitespace-nowrap text-[13px] tabular-nums text-muted">{rowLabel(f, split)}</span>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => remove(f.source.path)}
                  aria-label={`Remove ${f.source.path}`}
                  className="grid place-items-center rounded-md p-1.5 text-faint hover:bg-raised hover:text-neutral-100 disabled:opacity-50"
                >
                  <X size={14} />
                </button>
                {split && !f.counting && !f.source.fell_back_to_root && f.source.loose_image_count > 0 && (
                  <span className="col-span-3 -mt-1 text-xs text-amber-300">
                    {plural(f.source.loose_image_count, "image")} directly in this folder won't be in any library.
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Group>
      <Group>
        <SwitchRow
          checked={split}
          onChange={onSplit}
          disabled={locked}
          title="One library per subfolder"
          detail="For folders split by project, model or date. Each subfolder becomes a library you can filter on."
        />
      </Group>
    </section>
  );
}
