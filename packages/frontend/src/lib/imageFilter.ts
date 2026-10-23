// Image filter: the criteria selecting which Images the gallery shows, plus
// its pure URL round-trip. parseFilters / serializeFilters are the single
// source of truth so the URL and the Image feed query never drift.
//
// See CONTEXT.md › Frontend › Image filter.

import { api, apiRaw } from "./api";

export type ImageDoc = {
  _id: string;
  /** Only on the single-image fetch; the feed leaves it out. */
  library_id?: string;
  path: string;
  width?: number;
  height?: number;
  size?: number;
  // Ready-to-use thumbnail URL from the list payload: the API streaming route
  // (`/api/v1/images/{id}/thumb?v=`, versioned). Lets the grid render <img src> with no per-tile
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
  /** Only images with AI tags; ignored beside noTags / noAiTags. */
  aiTagged: boolean;
  // View only quarantined images instead of the default (quarantine-excluded)
  // feed. Off = default feed (quarantined hidden).
  quarantined: boolean;
  // Generation-metadata search: prompt terms (tokenized), checkpoint model,
  // and dimension bounds. promptTerms match against gen.prompt_terms.
  promptTerms: string[];
  promptLogic: TagLogic;
  model?: string;
  /** Loras the image used, every one (gen.loras). Search terms: they show
   * as `lora:name` chips in the search box (see searchTerms). */
  lora: string[];
  /** Embeddings either of its prompts used, every one (gen.embeddings);
   * `embedding:name` chips in the search box. */
  embedding: string[];
  /** Outfits the image wears, each (most of its tags): saved outfit ids, or
   * `default:<character>`. `outfit:Name` chips in the search box. */
  outfit: string[];
  /** Size presets ("2:3"): the image's shape is any of them. Matched by
   * ratio, so upscales count (services/image_shapes.py). */
  shape: string[];
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
  aiTagged: false,
  quarantined: false,
  promptTerms: [],
  promptLogic: "and",
  model: undefined,
  lora: [],
  embedding: [],
  outfit: [],
  shape: [],
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
    aiTagged: sp.get("ai_tagged") === "1" && sp.get("no_ai_tags") !== "1" && sp.get("no_tags") !== "1",
    quarantined: sp.get("quarantined") === "1",
    promptTerms: sp.getAll("pterms"),
    promptLogic: sp.get("plogic") === "or" ? "or" : "and",
    model: sp.get("model") || undefined,
    lora: sp.getAll("lora").filter(Boolean),
    embedding: sp.getAll("embedding").filter(Boolean),
    outfit: sp.getAll("outfit").filter(Boolean),
    shape: sp.getAll("shape").filter(Boolean),
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
  if (filters.aiTagged && !filters.noAiTags && !filters.noTags) sp.set("ai_tagged", "1");
  if (filters.quarantined) sp.set("quarantined", "1");
  filters.promptTerms.forEach((t) => sp.append("pterms", t));
  if (filters.promptTerms.length && filters.promptLogic)
    sp.set("plogic", filters.promptLogic);
  if (filters.model) sp.set("model", filters.model);
  filters.lora.forEach((n) => sp.append("lora", n));
  filters.embedding.forEach((n) => sp.append("embedding", n));
  filters.outfit.forEach((n) => sp.append("outfit", n));
  filters.shape.forEach((s) => sp.append("shape", s));
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
  const r = await apiRaw(`/api/v1/images?${qs}`, { signal: opts.signal });
  return {
    items: (await r.json()) as ImageDoc[],
    next: r.headers.get("X-Next-Cursor"),
  };
}

/** Fetch one page of the grouped (batch-collapsed) view. Offset-paged because
 * grouping is a server-side aggregation, not cursor-pageable. */
export function fetchGroupsPage(
  filters: Filters,
  opts: { offset?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<ImageDoc[]> {
  const sp = serializeFilters(filters);
  sp.set("limit", String(opts.limit ?? PAGE_LIMIT));
  sp.set("offset", String(opts.offset ?? 0));
  return api<ImageDoc[]>(`/api/v1/images/groups?${sp.toString()}`, { signal: opts.signal });
}

/** Fetch a single Image document by id. Throws on non-OK response. */
export function fetchImage(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageDoc> {
  return api<ImageDoc>(`/api/v1/images/${encodeURIComponent(id)}`, { signal: opts.signal });
}

/** Whether any filter axis is set (vs the empty default feed). */
export function hasActiveFilter(f: Filters): boolean {
  return (
    f.tags.length > 0 ||
    !!f.libraryId ||
    f.noTags ||
    f.noAiTags ||
    f.aiTagged ||
    f.quarantined ||
    f.promptTerms.length > 0 ||
    !!f.model ||
    f.lora.length > 0 ||
    f.embedding.length > 0 ||
    f.outfit.length > 0 ||
    f.shape.length > 0 ||
    f.minW != null ||
    f.maxW != null ||
    f.minH != null ||
    f.maxH != null ||
    !!f.groupId ||
    !!f.workflow ||
    !!f.workflowSig
  );
}

/**
 * `f` with its filters cleared: what "Clear filters" means everywhere. The
 * search (tags, loras, embeddings), the library tab, the order and the
 * grouping aren't filters the viewer set in the panel, so they stay.
 */
export function withoutFilters(f: Filters): Filters {
  return {
    ...DEFAULT_FILTERS,
    tags: f.tags,
    lora: f.lora,
    embedding: f.embedding,
    outfit: f.outfit,
    logic: f.logic,
    libraryId: f.libraryId,
    sort: f.sort,
    group: f.group,
    groupId: f.groupId,
  };
}

/** Whether `f` has anything for "Clear filters" to clear. */
export function hasClearableFilter(f: Filters): boolean {
  return serializeFilters(withoutFilters(f)).toString() !== serializeFilters(f).toString();
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
 * panel is closed. Search terms (tags, loras, embeddings) are left out (the
 * search input already shows them as chips), as are batch grouping and drill-in, which have their own
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
  if (f.logic === "or" && f.tags.length > 1) {
    add("logic", `Match any of ${f.tags.length} tags`, { logic: "and" });
  }
  if (f.noTags) add("noTags", "Untagged", { noTags: false });
  if (f.noAiTags) add("noAiTags", "No AI tags", { noAiTags: false });
  if (f.aiTagged && !f.noAiTags && !f.noTags) add("aiTagged", "AI tagged", { aiTagged: false });
  if (f.quarantined) add("quarantined", "Quarantined", { quarantined: false });
  for (const term of f.promptTerms) {
    add(`prompt:${term}`, `Prompt: ${term}`, {
      promptTerms: f.promptTerms.filter((t) => t !== term),
    });
  }
  if (f.promptLogic === "or" && f.promptTerms.length > 1) {
    add("promptLogic", `Match any of ${f.promptTerms.length} prompt terms`, {
      promptLogic: "and",
    });
  }
  if (f.workflow || f.workflowSig) {
    const name = workflowName({ workflow: f.workflow, workflowSig: f.workflowSig });
    add("workflow", `Workflow: ${name ?? "selected"}`, {
      workflow: undefined,
      workflowSig: undefined,
    });
  }
  if (f.model) add("model", `Model: ${f.model}`, { model: undefined });
  if (f.shape.length) add("shape", `Size: ${f.shape.join(", ")}`, { shape: [] });
  if (f.minW != null || f.maxW != null) {
    add("width", rangeLabel("Width", f.minW, f.maxW), { minW: undefined, maxW: undefined });
  }
  if (f.minH != null || f.maxH != null) {
    add("height", rangeLabel("Height", f.minH, f.maxH), { minH: undefined, maxH: undefined });
  }
  return chips;
}


/** How a lora, embedding or outfit reads as a search term: `lora:name`.
 * ComfyUI's own spelling; `emb:` is accepted as short for `embedding:`. */
export const RESOURCE_PREFIXES = { lora: "lora:", embedding: "embedding:", outfit: "outfit:" } as const;
export type ResourceKind = keyof typeof RESOURCE_PREFIXES;
const TYPED_PREFIX = /^(lora|embedding|emb|outfit):\s*(.+)$/i;

/** A typed search term's lora, embedding or outfit, if it names one. Pure. */
export function resourceOf(term: string): { kind: ResourceKind; name: string } | null {
  const m = TYPED_PREFIX.exec(term.trim());
  if (!m) return null;
  const k = m[1].toLowerCase();
  return { kind: k === "lora" ? "lora" : k === "outfit" ? "outfit" : "embedding", name: m[2].trim() };
}

/** A saved outfit as the search box knows it. */
export type KnownOutfit = { id: string; name: string };

/** Everything the search box shows as chips: tags, then loras, embeddings
 * and outfits (by name; `outfits` gives the names for the ids), each as its
 * search term. Pure. */
export function searchTerms(f: Filters, outfits: readonly KnownOutfit[] = []): string[] {
  return [
    ...f.tags,
    ...f.lora.map((n) => RESOURCE_PREFIXES.lora + n),
    ...f.embedding.map((n) => RESOURCE_PREFIXES.embedding + n),
    ...f.outfit.map((id) => RESOURCE_PREFIXES.outfit + outfitName(id, outfits)),
  ];
}

/** An outfit's name for its chip; one the list doesn't name reads as its
 * id, a character's Default as "Default, <character>". Pure. */
function outfitName(id: string, outfits: readonly KnownOutfit[]): string {
  const known = outfits.find((o) => o.id === id)?.name;
  if (known) return known;
  return id.startsWith("default:") ? `Default, ${id.slice(8).replace(/_/g, " ")}` : id;
}

/**
 * `f` with the search box's chips put back where they belong: `lora:` and
 * `embedding:` terms into their lists (never into tags, whose names the
 * backend respells), the rest as tags. `known` resolves a typed name to the
 * one the library uses (`nahidaxl` is `NahidaXL`): matching is exact. Pure.
 */
export function withSearchTerms(
  f: Filters,
  terms: readonly string[],
  known: Partial<Record<"lora" | "embedding", readonly string[]>> = {},
  outfits: { list: readonly KnownOutfit[]; tags?: ReadonlySet<string> } = { list: [] },
): Filters {
  const next = { tags: [] as string[], lora: [] as string[], embedding: [] as string[], outfit: [] as string[] };
  const outfitNamed = (name: string) => {
    const lower = name.toLowerCase();
    return outfits.list.find((o) => o.name.toLowerCase() === lower);
  };
  // An outfit chip already in the filter keeps its id (a Default has no name
  // in the list): the term it shows maps back to it.
  const shown = new Map(f.outfit.map((id) => [RESOURCE_PREFIXES.outfit + outfitName(id, outfits.list), id]));
  for (const term of terms) {
    // A bare `lora:` with no name yet is nothing to search for.
    if (/^(lora|embedding|emb|outfit):\s*$/i.test(term.trim())) continue;
    const r = resourceOf(term);
    if (!r) {
      // A plain name that is an outfit, and not a tag the library has.
      const o = outfitNamed(term.trim());
      if (o && !outfits.tags?.has(term.trim().replace(/\s+/g, "_"))) {
        if (!next.outfit.includes(o.id)) next.outfit.push(o.id);
      } else next.tags.push(term);
      continue;
    }
    if (r.kind === "outfit") {
      const id = shown.get(term) ?? outfitNamed(r.name)?.id;
      if (id && !next.outfit.includes(id)) next.outfit.push(id);
      continue;
    }
    const lower = r.name.toLowerCase();
    const name = known[r.kind]?.find((k) => k.toLowerCase() === lower) ?? r.name;
    if (!next[r.kind].includes(name)) next[r.kind].push(name);
  }
  return { ...f, ...next };
}
