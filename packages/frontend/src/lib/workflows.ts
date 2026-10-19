/**
 * Naming ComfyUI workflows for people.
 *
 * Moiré groups images by *signature* (the multiset of node types in the graph
 * that ran), which is what extraction rules key on. A person thinks in saved
 * workflow files instead ("RemoteQV2.2.json"). Two facts bridge them:
 *
 * - Every image embeds its editor graph, whose top-level `id` ComfyUI keeps
 *   across edits, copies and Save As. One id is therefore a *family*: one
 *   workflow and all its versions.
 * - A saved file has the same editor format, so its node types can be matched
 *   against an image's to name each version after the file it came from.
 *
 * Each version is titled by what it does ("Text to image + Face fix"), never
 * by raw node class names; a matched file name is shown beside it.
 */

import type { SignatureRow } from "./gen";

/** What the browser extracts from a dropped `.json` (nothing else is sent). */
export type WorkflowFile = {
  workflow_id: string;
  filename: string;
  node_types: string[];
};

/** "workflows/RemoteQV2.2.json" → "RemoteQV2.2". */
export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.json$/i, "");
}

/**
 * Read a saved ComfyUI workflow file. Null for anything that isn't one
 * (an API-format prompt export has no `nodes` array or `id`).
 */
export function parseWorkflowFile(text: string, filename: string): WorkflowFile | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const { id, nodes } = doc as { id?: unknown; nodes?: unknown };
  if (typeof id !== "string" || !id || !Array.isArray(nodes)) return null;
  const node_types = nodes
    .map((n) => (n && typeof n === "object" ? (n as { type?: unknown }).type : null))
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  return { workflow_id: id, filename: fileStem(filename), node_types };
}

// What a node contributes, in pipeline order. Only steps a person would name
// are listed; core plumbing (samplers, encoders, loaders) and helpers that
// just feed a named step are left out on purpose.
const CAPABILITIES: Array<[RegExp, string]> = [
  [/ControlNet/i, "ControlNet"],
  [/IPAdapter/i, "IP-Adapter"],
  [/Lora/i, "LoRA"],
  [/Inpaint|SetLatentNoiseMask/i, "Inpaint"],
  [/FaceDetailer|FaceRestore|ReActor/i, "Face fix"],
  [/^(UltimateSDUpscale|ImageUpscaleWithModel|LatentUpscale.*|.*ESRGAN.*|SUPIR.*)$/i, "Upscale"],
];

/**
 * What a workflow version does, from its full node set: where it starts
 * ("Text to image" from an empty latent, "From an image" from a loaded one)
 * and the steps it adds ("4 LoRAs", "Face fix", "Upscale"), e.g.
 * "4 LoRAs + Face fix + Upscale". Text to image is the usual start, so it is
 * only spelled out when there are no steps to name.
 */
export function versionLabel(row: Pick<SignatureRow, "node_types">): string {
  const types = Object.entries(row.node_types ?? {});
  const has = (re: RegExp) => types.some(([t]) => re.test(t));
  const source = has(/^Empty ?Latent/i)
    ? "Text to image"
    : has(/^LoadImage/)
      ? "From an image"
      : null;
  const counts = new Map<string, number>();
  for (const [type, n] of types) {
    const hit = CAPABILITIES.find(([re]) => re.test(type));
    if (hit) counts.set(hit[1], (counts.get(hit[1]) ?? 0) + n);
  }
  const steps = CAPABILITIES.map(([, label]) => label)
    .filter((label, i, all) => all.indexOf(label) === i && counts.has(label))
    .map((label) => {
      const n = counts.get(label) ?? 0;
      return label === "LoRA" ? `${n} ${n === 1 ? "LoRA" : "LoRAs"}` : label;
    });
  // Text-to-image is the default starting point, so it only names a version
  // that adds nothing; "From an image" always says something.
  if (steps.length) {
    return (source === "From an image" ? [source, ...steps] : steps).join(" + ");
  }
  return source ?? "Workflow";
}

/**
 * When a version was in use, from epoch seconds: "Oct 3", "Oct 3 to 12",
 * "Sep 30 to Dec 7", "Nov 8, 2025 to Jan 15". The year shows only when it
 * isn't the current one. `now` is injectable for tests.
 */
export function formatUsedRange(
  first: number | null | undefined,
  last: number | null | undefined,
  now: Date = new Date(),
): string | null {
  if (first == null && last == null) return null;
  const a = new Date((first ?? last)! * 1000);
  const b = new Date((last ?? first)! * 1000);
  const md = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const yr = (d: Date) => (d.getFullYear() === now.getFullYear() ? "" : `, ${d.getFullYear()}`);
  const sameDay = a.toDateString() === b.toDateString();
  if (sameDay) return md(a) + yr(a);
  const sameYear = a.getFullYear() === b.getFullYear();
  if (sameYear && a.getMonth() === b.getMonth()) {
    return `${md(a)} to ${b.getDate()}${yr(b)}`;
  }
  return `${md(a)}${sameYear ? "" : yr(a)} to ${md(b)}${yr(b)}`;
}

export type WorkflowVersion = {
  row: SignatureRow;
  /** What the version does; when several read the same, when it was used. */
  title: string;
  /** The other of the two: the date range under a capability title, or the
   * capability under a date title. Null when there is nothing to add. */
  note: string | null;
  /** The imported file it came from: "RemoteQV2.2" when the node sets are
   * identical, "like RemoteQV2.2" when merely close. Null when unmatched, or
   * when it is the file the whole group is already named after. */
  file: string | null;
};

export type WorkflowFamily = {
  /** Null groups images with no editor-graph id (non-ComfyUI, old exports). */
  id: string | null;
  name: string;
  /** True when `name` is a fallback the user hasn't confirmed. */
  unnamed: boolean;
  images: number;
  versions: WorkflowVersion[];
};

/**
 * Group signature rows into workflow families, largest first, with versions
 * ordered by first use (the order they were built up).
 * A family is named by the user's name, else the newest matched filename,
 * else "Unnamed workflow". Versions are titled by what they do; when several
 * read the same, by when they were used instead, so no two rows look alike.
 */
export function groupWorkflows(
  rows: SignatureRow[],
  now: Date = new Date(),
): WorkflowFamily[] {
  const byId = new Map<string | null, SignatureRow[]>();
  for (const r of rows) {
    const key = r.workflow_id ?? null;
    byId.set(key, [...(byId.get(key) ?? []), r]);
  }
  const families: WorkflowFamily[] = [];
  for (const [id, members] of byId) {
    // Oldest first: the list then reads as the workflow's history.
    const sorted = [...members].sort(
      (a, b) =>
        (a.first_used ?? Infinity) - (b.first_used ?? Infinity) ||
        (a.node_count ?? 0) - (b.node_count ?? 0) ||
        b.count - a.count,
    );
    const labels = sorted.map((row) => versionLabel(row));
    const tally = new Map<string, number>();
    for (const l of labels) tally.set(l, (tally.get(l) ?? 0) + 1);
    const seen = new Map<string, number>();
    const versions = sorted.map((row, i) => {
      const label = labels[i];
      const when = formatUsedRange(row.first_used, row.last_used, now);
      const file = row.file_name
        ? (row.file_match ?? 0) >= 1
          ? row.file_name
          : `like ${row.file_name}`
        : null;
      // A label shared by several versions can't tell them apart (small
      // edits of one file look identical to it); when they were used can.
      // A label every version shares says nothing about any one of them.
      const shared = (tally.get(label) ?? 0) > 1 && when;
      const base = shared ? when : label;
      const note = shared ? (tally.get(label) === sorted.length ? null : label) : when;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { row, title: n > 1 ? `${base} (${n})` : base, note, file };
    });
    const files = members
      .map((m) => m.file_name)
      .filter((f): f is string => !!f)
      .sort();
    const named = members.find((m) => m.workflow_name)?.workflow_name;
    const name =
      named ?? files[files.length - 1] ?? (id ? "Unnamed workflow" : "Other images");
    // A version's file only earns a line when it differs from the name in
    // the group header; repeating the header under every row is noise.
    for (const v of versions) {
      if (v.row.file_name === name) v.file = null;
    }
    families.push({
      id,
      name,
      unnamed: !named,
      images: members.reduce((n, m) => n + m.count, 0),
      versions,
    });
  }
  return families.sort(
    (a, b) => Number(a.id === null) - Number(b.id === null) || b.images - a.images,
  );
}

/**
 * Display name for a gallery workflow filter: the family's name, or
 * "Family · version title" for a single version. Undefined while the
 * families haven't loaded or when nothing matches.
 */
export function workflowFilterName(
  families: readonly WorkflowFamily[],
  key: { workflow?: string; workflowSig?: string },
): string | undefined {
  if (key.workflow) return families.find((f) => f.id === key.workflow)?.name;
  if (!key.workflowSig) return undefined;
  for (const fam of families) {
    const v = fam.versions.find((v) => v.row.workflow_sig === key.workflowSig);
    if (v) return fam.versions.length > 1 ? `${fam.name} · ${v.title}` : fam.name;
  }
  return undefined;
}

export async function putWorkflowName(id: string, name: string): Promise<void> {
  const r = await fetch(`/api/v1/rules/workflows/${encodeURIComponent(id)}/name`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(await r.text());
}

// The server takes at most 500 files per request; a whole workflows folder
// can hold more, so imports go in batches.
const IMPORT_BATCH = 200;

/** Import files in batches; `known` counts distinct workflows in the library
 * that any of them belong to. */
export async function importWorkflowFiles(
  files: WorkflowFile[],
): Promise<{ imported: number; known: number }> {
  let imported = 0;
  const known = new Set<string>();
  for (let i = 0; i < files.length; i += IMPORT_BATCH) {
    const r = await fetch("/api/v1/rules/workflow-files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(files.slice(i, i + IMPORT_BATCH)),
    });
    if (!r.ok) throw new Error(await r.text());
    const res = (await r.json()) as { imported: number; known_ids?: string[] };
    imported += res.imported;
    for (const id of res.known_ids ?? []) known.add(id);
  }
  return { imported, known: known.size };
}
