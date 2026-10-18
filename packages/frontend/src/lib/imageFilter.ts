// Image filter: the criteria selecting which Images the gallery shows, plus
// its pure URL round-trip. parseFilters / serializeFilters are the single
// source of truth so the URL and the Image feed query never drift.
//
// See CONTEXT.md › Frontend › Image filter.

export type ImageDoc = {
  _id: string;
  path: string;
  width?: number;
  height?: number;
  size?: number;
  // Ready-to-use thumbnail URL from the list payload: the API streaming route
  // (`/api/v1/images/{id}/thumb`). Lets the grid render <img src> with no per-tile
  // resolve request. See api/images.list_images.
  thumb_url?: string;
  // Compact blurred-preview hash; decoded to an instant placeholder so tiles
  // never show a grey loading skeleton. See services/blurhash.py.
  blurhash?: string;
  tags?: string[];
  // Null, not undefined, when unset: these come straight from SQL columns.
  rating?: string | null;
  // 0-5 quality score (distinct from `rating`, the content-safety axis).
  score?: number | null;
  // Batch grouping (grouped view only): the representative's group + member
  // count. group_count > 1 means this tile stands for a batch of variations.
  group_id?: string;
  group_count?: number;
  // DB-only curation flag; quarantined images leave the default feed.
  quarantined?: boolean;
  // File modification time (epoch seconds): the feed's newest-first sort key
  // and half of its cursor. Null for rows scanned without one.
  mtime?: number | null;
  // Summary flag maintained by services/image_tags.py. The grid draws an
  // "untagged" marker from it so an un-AI-tagged image is visible at a glance.
  has_ai_tags?: boolean;
  // Structured generation metadata (extracted from embedded AI-art data).
  gen?: import("./gen").GenMeta;
  ai?: import("./tags").AiTagMeta & {
    rating?: Record<string, number>;
  };
};

export type TagLogic = "and" | "or";

/** Feed order; see services/image_feed.py `SORTS`. */
export type FeedSort = "newest" | "oldest" | "top";
const SORTS: readonly FeedSort[] = ["newest", "oldest", "top"];

export type Filters = {
  tags: string[];
  logic: TagLogic;
  libraryId?: string;
  noTags: boolean;
  noAiTags: boolean;
  // View only quarantined images instead of the default (quarantine-excluded)
  // feed. Off = default feed (quarantined hidden).
  quarantined: boolean;
  // Generation-metadata search: prompt terms (tokenized), checkpoint model,
  // and dimension bounds. promptTerms match against gen.prompt_terms.
  promptTerms: string[];
  promptLogic: TagLogic;
  model?: string;
  minW?: number;
  maxW?: number;
  minH?: number;
  maxH?: number;
  // Batch grouping: `group` collapses the feed into batches (grouped view);
  // `groupId` drills into one batch's members (ungrouped). Mutually exclusive
  // in practice: drilling in turns collapse off.
  group: boolean;
  groupId?: string;
  // Workflow: a whole family (its editor-graph id, every version Rules groups
  // under it) or one version (its signature). One or the other.
  workflow?: string;
  workflowSig?: string;
  // How the feed is ordered. An order, not a filter: never a chip, never
  // makes the feed "filtered".
  sort: FeedSort;
};

export const DEFAULT_FILTERS: Filters = {
  tags: [],
  logic: "and",
  libraryId: undefined,
  noTags: false,
  noAiTags: false,
  quarantined: false,
  promptTerms: [],
  promptLogic: "and",
  model: undefined,
  minW: undefined,
  maxW: undefined,
  minH: undefined,
  maxH: undefined,
  group: false,
  groupId: undefined,
  workflow: undefined,
  workflowSig: undefined,
  sort: "newest",
};

/** Default page size for the Image feed. */
export const PAGE_LIMIT = 100;

/**
 * Read an Image filter out of URL search params.
 *
 * Back-compat: accepts the legacy singular `tag` param as well as `tags`.
 * serializeFilters always emits `tags`, so simply re-pushing a parsed filter
 * migrates a legacy URL; no separate migration step needed.
 */
export function parseFilters(sp: URLSearchParams): Filters {
  const tags = sp.getAll("tags");
  const legacy = sp.getAll("tag");
  const logic = sp.get("logic");
  return {
    tags: tags.length ? tags : legacy,
    logic: logic === "or" ? "or" : "and",
    libraryId: sp.get("library_id") || undefined,
    noTags: sp.get("no_tags") === "1",
    noAiTags: sp.get("no_ai_tags") === "1",
    quarantined: sp.get("quarantined") === "1",
    promptTerms: sp.getAll("pterms"),
    promptLogic: sp.get("plogic") === "or" ? "or" : "and",
    model: sp.get("model") || undefined,
    minW: numOrUndef(sp.get("min_w")),
    maxW: numOrUndef(sp.get("max_w")),
    minH: numOrUndef(sp.get("min_h")),
    maxH: numOrUndef(sp.get("max_h")),
    group: sp.get("group") === "1",
    groupId: sp.get("group_id") || undefined,
    workflow: sp.get("workflow") || undefined,
    workflowSig: sp.get("workflow_sig") || undefined,
    sort: SORTS.find((x) => x === sp.get("sort")) ?? "newest",
  };
}

function numOrUndef(v: string | null): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Serialize an Image filter to URL search params (filter params only, no
 * pagination cursor/limit). Used both for pushing the gallery URL and for
 * carrying the filter when navigating to ImageView.
 */
export function serializeFilters(filters: Filters): URLSearchParams {
  const sp = new URLSearchParams();
  filters.tags.forEach((t) => sp.append("tags", t));
  if (filters.logic) sp.set("logic", filters.logic);
  if (filters.libraryId) sp.set("library_id", filters.libraryId);
  if (filters.noTags) sp.set("no_tags", "1");
  if (filters.noAiTags) sp.set("no_ai_tags", "1");
  if (filters.quarantined) sp.set("quarantined", "1");
  filters.promptTerms.forEach((t) => sp.append("pterms", t));
  if (filters.promptTerms.length && filters.promptLogic)
    sp.set("plogic", filters.promptLogic);
  if (filters.model) sp.set("model", filters.model);
  if (filters.minW != null) sp.set("min_w", String(filters.minW));
  if (filters.maxW != null) sp.set("max_w", String(filters.maxW));
  if (filters.minH != null) sp.set("min_h", String(filters.minH));
  if (filters.maxH != null) sp.set("max_h", String(filters.maxH));
  if (filters.group) sp.set("group", "1");
  if (filters.groupId) sp.set("group_id", filters.groupId);
  if (filters.workflow) sp.set("workflow", filters.workflow);
  if (filters.workflowSig) sp.set("workflow_sig", filters.workflowSig);
  if (filters.sort && filters.sort !== "newest") sp.set("sort", filters.sort);
  return sp;
}

/**
 * Query string for the batch-peek fetch (see useBatchScrub): every active
 * filter except `group`/`group_id`, which the peek sets itself to scope to
 * one batch's members. Without this, the peek fetched a batch's members
 * unfiltered while the grouped feed picks each batch's *representative*
 * honoring the active filter: under a tag or quarantine filter those can
 * disagree, so hovering could swap the tile to a different image than the
 * one it was showing at rest.
 */
export function serializeFiltersForPeek(filters: Filters): string {
  const sp = serializeFilters(filters);
  sp.delete("group");
  sp.delete("group_id");
  return sp.toString();
}

/**
 * Build the `/api/v1/images` query string for one page of the Image feed:
 * the filter params plus pagination (limit, optional cursor).
 */
export function buildImagesQuery(
  filters: Filters,
  opts: { cursor?: string | null; limit?: number } = {},
): string {
  const sp = serializeFilters(filters);
  sp.set("limit", String(opts.limit ?? PAGE_LIMIT));
  if (opts.cursor) sp.set("cursor", opts.cursor);
  return sp.toString();
}

/**
 * One page of the Image feed and the cursor for the page after it. The server
 * builds the cursor (`X-Next-Cursor`) from the values it sorted on; building
 * it here from cached items went wrong as soon as a local edit (a new score
 * under "top") changed the last item's sort key.
 */
export type FeedPage = { items: ImageDoc[]; next: string | null };

/** Fetch one page of the Image feed. Throws on non-OK response. */
export async function fetchImagesPage(
  filters: Filters,
  opts: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<FeedPage> {
  const qs = buildImagesQuery(filters, opts);
  const r = await fetch(`/api/v1/images?${qs}`, { signal: opts.signal });
  if (!r.ok) throw new Error(await r.text());
  return {
    items: (await r.json()) as ImageDoc[],
    next: r.headers.get("X-Next-Cursor"),
  };
}

/** Fetch one page of the grouped (batch-collapsed) view. Offset-paged because
 * grouping is a server-side aggregation, not cursor-pageable. */
export async function fetchGroupsPage(
  filters: Filters,
  opts: { offset?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<ImageDoc[]> {
  const sp = serializeFilters(filters);
  sp.set("limit", String(opts.limit ?? PAGE_LIMIT));
  sp.set("offset", String(opts.offset ?? 0));
  const r = await fetch(`/api/v1/images/groups?${sp.toString()}`, {
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as ImageDoc[];
}

/** Fetch a single Image document by id. Throws on non-OK response. */
export async function fetchImage(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDoc> {
  const r = await fetch(`/api/v1/images/${encodeURIComponent(id)}`, {
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as ImageDoc;
}

/** Whether any filter axis is set (vs the empty default feed). */
export function hasActiveFilter(f: Filters): boolean {
  return (
    f.tags.length > 0 ||
    !!f.libraryId ||
    f.noTags ||
    f.noAiTags ||
    f.quarantined ||
    f.promptTerms.length > 0 ||
    !!f.model ||
    f.minW != null ||
    f.maxW != null ||
    f.minH != null ||
    f.maxH != null ||
    !!f.groupId ||
    !!f.workflow ||
    !!f.workflowSig
  );
}

export type FilterChip = {
  /** Stable React key. */
  key: string;
  label: string;
  /** The filters with just this one removed. */
  without: Filters;
};

function rangeLabel(name: string, min?: number, max?: number): string {
  if (min != null && max != null) return `${name} ${min}–${max}`;
  if (min != null) return `${name} ≥ ${min}`;
  return `${name} ≤ ${max}`;
}

/**
 * The active filters as removable chips, for showing state while the filter
 * panel is closed. Search tags are left out (the search input already shows
 * them as chips), as are batch grouping and drill-in, which have their own
 * toggle and "Back to batches" control. `libraryName` resolves an id to a
 * display name; `workflowName` does the same for a workflow family id or a
 * version signature.
 */
export function activeFilterChips(
  f: Filters,
  libraryName: (id: string) => string | undefined = () => undefined,
  workflowName: (key: { workflow?: string; workflowSig?: string }) => string | undefined = () =>
    undefined,
): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: string, label: string, patch: Partial<Filters>) =>
    chips.push({ key, label, without: { ...f, ...patch } });

  if (f.libraryId) {
    add("library", `Library: ${libraryName(f.libraryId) ?? f.libraryId}`, { libraryId: undefined });
  }
  if (f.logic === "or" && f.tags.length > 1) add("logic", "Any tag", { logic: "and" });
  if (f.noTags) add("noTags", "Untagged", { noTags: false });
  if (f.noAiTags) add("noAiTags", "No AI tags", { noAiTags: false });
  if (f.quarantined) add("quarantined", "Quarantined", { quarantined: false });
  for (const term of f.promptTerms) {
    add(`prompt:${term}`, `Prompt: ${term}`, {
      promptTerms: f.promptTerms.filter((t) => t !== term),
    });
  }
  if (f.promptLogic === "or" && f.promptTerms.length > 1) {
    add("promptLogic", "Any prompt term", { promptLogic: "and" });
  }
  if (f.workflow || f.workflowSig) {
    const name = workflowName({ workflow: f.workflow, workflowSig: f.workflowSig });
    add("workflow", `Workflow: ${name ?? "selected"}`, {
      workflow: undefined,
      workflowSig: undefined,
    });
  }
  if (f.model) add("model", `Model: ${f.model}`, { model: undefined });
  if (f.minW != null || f.maxW != null) {
    add("width", rangeLabel("Width", f.minW, f.maxW), { minW: undefined, maxW: undefined });
  }
  if (f.minH != null || f.maxH != null) {
    add("height", rangeLabel("Height", f.minH, f.maxH), { minH: undefined, maxH: undefined });
  }
  return chips;
}

