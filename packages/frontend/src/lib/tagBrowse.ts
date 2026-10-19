/**
 * The Tags page's pure logic: which tags show, in what order and section,
 * where a tag links, and how its detail reads (months, workflows, renames).
 * The page itself only wires these to queries and markup.
 */
import { ANY_PREFIX, MANUAL_PREFIX, PROMPT_PREFIX, formatTag, tagQueryText } from "./tags";
import { workflowFilterName, type WorkflowFamily } from "./workflows";

export type TagSource = "all" | "ai" | "prompt" | "manual";
export type TagSort = "count" | "name" | "recent";
export type TagView = "grid" | "list";
export type TagCategory = "character" | "general";

/** One entry of `/tags/browse`: a tag name, its sources merged. */
export type BrowseTag = {
  tag: string;
  count: number;
  category: TagCategory;
  /** Newest file time (seconds) of an image with the tag. */
  last_used: number | null;
  thumb_image_id: string | null;
  thumb_url: string | null;
};

/** `/tags/detail`: what the side panel shows for one tag. */
export type TagDetail = {
  tag: string;
  count: number;
  category: TagCategory;
  first_used: number | null;
  last_used: number | null;
  sources: Record<Exclude<TagSource, "all">, number>;
  /** Images per calendar month ("2026-03"), months with none left out. */
  months: Array<{ month: string; count: number }>;
  loras: Array<{ name: string; count: number }>;
  workflows: Array<{ sig: string; count: number }>;
  /** Tags on the same images, most shared first, boilerplate included. */
  related: Array<{ tag: string; count: number }>;
  thumb_image_id: string | null;
  thumb_url: string | null;
};

export const SOURCE_LABEL: Record<TagSource, string> = {
  all: "All sources",
  ai: "AI",
  prompt: "Prompt",
  manual: "Manual",
};

export const SORT_LABEL: Record<TagSort, string> = {
  count: "Most images",
  name: "Name",
  recent: "Recently used",
};

/** The gallery tag a Tags page entry links to: the same images it counts. */
export function galleryTag(tag: string, source: TagSource): string {
  if (source === "all") return `${ANY_PREFIX}${tag}`;
  if (source === "prompt") return `${PROMPT_PREFIX}${tag}`;
  if (source === "manual") return `${MANUAL_PREFIX}${tag}`;
  return tag;
}

/** Tags matching the search box, boilerplate dropped unless asked for. */
export function filterTags(
  rows: readonly BrowseTag[],
  query: string,
  isBoilerplate: ((tag: string) => boolean) | null,
): BrowseTag[] {
  const needle = tagQueryText(query.trim());
  return rows.filter(
    (r) =>
      !(isBoilerplate && isBoilerplate(r.tag)) &&
      (!needle || formatTag(r.tag).toLowerCase().includes(needle)),
  );
}

/** A new array in `sort` order; ties fall back to the name. */
export function sortTags(rows: readonly BrowseTag[], sort: TagSort): BrowseTag[] {
  const byName = (a: BrowseTag, b: BrowseTag) => a.tag.localeCompare(b.tag);
  const out = [...rows];
  if (sort === "name") return out.sort(byName);
  if (sort === "recent") {
    return out.sort((a, b) => (b.last_used ?? -1) - (a.last_used ?? -1) || byName(a, b));
  }
  return out.sort((a, b) => b.count - a.count || byName(a, b));
}

/** Characters first, as their own section; everything else after. */
export function splitSections(rows: readonly BrowseTag[]): {
  characters: BrowseTag[];
  general: BrowseTag[];
} {
  return {
    characters: rows.filter((r) => r.category === "character"),
    general: rows.filter((r) => r.category !== "character"),
  };
}

/**
 * The last `n` calendar months ending at `now`'s month, each with its count
 * (0 where the detail had none), oldest first: a chart's bars to scale.
 */
export function recentMonths(
  months: TagDetail["months"],
  n: number,
  now: Date = new Date(),
): Array<{ month: string; count: number }> {
  const counts = new Map(months.map((m) => [m.month, m.count]));
  const out: Array<{ month: string; count: number }> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ month: key, count: counts.get(key) ?? 0 });
  }
  return out;
}

/** How many months a tag's chart covers: back to its first use, at least a
 * year (so a new tag isn't one fat bar) and at most two. */
export function chartMonths(firstUsed: number | null, now: Date = new Date()): number {
  if (firstUsed == null) return 12;
  const first = new Date(firstUsed * 1000);
  const span =
    (now.getFullYear() - first.getFullYear()) * 12 + now.getMonth() - first.getMonth() + 1;
  return Math.min(24, Math.max(12, span));
}

/** "Mar 2026" for a "2026-03" month key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

export type TagWorkflow = {
  name: string;
  count: number;
  /** Gallery filter for it: a whole family, or one version without one. */
  filter: { workflow: string } | { workflowSig: string };
};

/**
 * A tag's per-signature counts as workflows, named the way the Rules page
 * names them: signatures of one family add up; a signature outside every
 * known family stands alone under its family's fallback name.
 */
export function tagWorkflows(
  rows: TagDetail["workflows"],
  families: readonly WorkflowFamily[],
): TagWorkflow[] {
  const familyOf = new Map<string, WorkflowFamily>();
  for (const f of families) for (const v of f.versions) familyOf.set(v.row.workflow_sig, f);
  const out = new Map<string, TagWorkflow>();
  for (const r of rows) {
    const fam = familyOf.get(r.sig);
    const key = fam?.id ? `w:${fam.id}` : `s:${r.sig}`;
    const prev = out.get(key);
    if (prev) {
      prev.count += r.count;
      continue;
    }
    out.set(key, {
      // Images outside every family can only be filtered one version at a
      // time, so each is named by what it does, as the gallery chip does.
      name: fam?.id
        ? fam.name
        : (workflowFilterName(families, { workflowSig: r.sig }) ?? "Unnamed workflow"),
      count: r.count,
      filter: fam?.id ? { workflow: fam.id } : { workflowSig: r.sig },
    });
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

/** The stored tags a rename can move: AI tags keep the model's name. */
export function renamableTags(detail: Pick<TagDetail, "tag" | "sources">): string[] {
  const out: string[] = [];
  if (detail.sources.prompt) out.push(`${PROMPT_PREFIX}${detail.tag}`);
  if (detail.sources.manual) out.push(`${MANUAL_PREFIX}${detail.tag}`);
  return out;
}
