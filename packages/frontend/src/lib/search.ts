/**
 * The Ctrl/Cmd+K search's pure logic: everything it can open, as rows, and
 * how a query ranks them. Every source is a list the app already fetches
 * (tags, characters, workflows, batches, libraries, loras…), so matching
 * runs here, with `fuzzyScore`, like the tag search box.
 */
import { fuzzyScore } from "./fuzzy";
import { displayName, characterHref, tagHref, type CharacterEntry } from "./character";
import { formatTag, tagQueryText } from "./tags";
import { libraryGalleryHref, type Library } from "./queries";
import { DEFAULT_FILTERS, serializeFilters, type Filters } from "./imageFilter";
import type { BrowseTag } from "./tagBrowse";
import { groupHref, groupOptions, type TagGroups } from "./tagGroups";
import type { BatchSummary, Generator } from "./generate";

export type SearchGroup =
  | "pages"
  | "settings"
  | "characters"
  | "tags"
  | "groups"
  | "workflows"
  | "generations"
  | "libraries"
  | "loras"
  | "embeddings"
  | "checkpoints";

/** Headings, in the order groups show when their best matches tie. */
export const GROUP_LABEL: Record<SearchGroup, string> = {
  pages: "Pages",
  settings: "Settings",
  characters: "Characters",
  tags: "Tags",
  groups: "Tag groups",
  workflows: "Workflows",
  generations: "Generations",
  libraries: "Libraries",
  loras: "LoRAs",
  embeddings: "Embeddings",
  checkpoints: "Checkpoints",
};
const ORDER = Object.keys(GROUP_LABEL) as SearchGroup[];

/** Rows a group shows for a query; the rest stay a keystroke away. */
const LIMIT: Record<SearchGroup, number> = {
  pages: 4,
  settings: 3,
  characters: 5,
  tags: 6,
  groups: 3,
  workflows: 4,
  generations: 4,
  libraries: 3,
  loras: 3,
  embeddings: 3,
  checkpoints: 3,
};

export type SearchItem = {
  /** Unique across groups. */
  key: string;
  group: SearchGroup;
  label: string;
  /** Quieter text after the label (a series, a workflow, a path). */
  detail?: string;
  /** At the row's end (an image count). */
  hint?: string;
  href: string;
  /** What the query matches, besides the label. */
  also?: string[];
  thumb?: string | null;
  character?: CharacterEntry;
};

export type SearchSection = { group: SearchGroup; items: SearchItem[] };

const count = (n: number) => n.toLocaleString();

const galleryHref = (patch: Partial<Filters>) => {
  const qs = serializeFilters({ ...DEFAULT_FILTERS, ...patch }).toString();
  return qs ? `/?${qs}` : "/";
};

export function characterItems(rows: readonly CharacterEntry[]): SearchItem[] {
  return rows.map((c) => {
    const { name, series } = displayName(c);
    return {
      key: `character:${c.tag}`,
      group: "characters",
      label: name,
      detail: series ?? undefined,
      hint: c.count ? count(c.count) : undefined,
      href: characterHref(c.tag),
      also: [formatTag(c.tag), ...c.aliases.map(formatTag)],
      thumb: c.thumb_url,
      character: c,
    };
  });
}

/** Tags that aren't characters (those come from `characterItems`). */
export function tagItems(rows: readonly BrowseTag[]): SearchItem[] {
  return rows
    .filter((t) => t.category !== "character")
    .map((t) => ({
      key: `tag:${t.tag}`,
      group: "tags",
      label: formatTag(t.tag),
      hint: count(t.count),
      href: tagHref(t.tag),
      thumb: t.thumb_url,
    }));
}

/** Tag groups (attire, headwear, ...) with how many library tags each holds. */
export function groupItems(groups: TagGroups | undefined): SearchItem[] {
  if (!groups) return [];
  return groupOptions(groups).map((o) => ({
    key: `group:${o.value}`,
    group: "groups",
    label: o.label,
    detail: o.group,
    hint: `${o.hint} ${o.hint === "1" ? "tag" : "tags"}`,
    href: groupHref(o.value),
  }));
}

export function workflowItems(rows: readonly Generator[]): SearchItem[] {
  return rows.map((g) => ({
    key: `workflow:${g._id}`,
    group: "workflows",
    label: g.name,
    detail: g.kind === "builtin" ? "Built-in" : g.ready ? undefined : "Not tested yet",
    href: `/generate?${new URLSearchParams({ workflow: g._id })}`,
  }));
}

export function generationItems(rows: readonly BatchSummary[]): SearchItem[] {
  return rows.map((b) => ({
    key: `batch:${b._id}`,
    group: "generations",
    label: b.name,
    detail: b.generator ?? undefined,
    hint: b.images ? `${count(b.images)} ${b.images === 1 ? "image" : "images"}` : undefined,
    href: `/generations/${b._id}`,
    thumb: b.thumbs[0] ?? null,
  }));
}

export function libraryItems(rows: readonly Library[]): SearchItem[] {
  return rows
    .filter((l) => !l.deleting)
    .map((l) => ({
      key: `library:${l._id}`,
      group: "libraries",
      label: l.name || l.path,
      detail: l.name ? l.path : undefined,
      hint: l.indexed_count != null ? count(l.indexed_count) : undefined,
      href: libraryGalleryHref(l._id),
    }));
}

/** LoRAs, embeddings or checkpoints the library's images used: each opens
 * the gallery filtered to it. */
export function resourceItems(
  group: "loras" | "embeddings" | "checkpoints",
  rows: readonly { name: string; count: number }[],
): SearchItem[] {
  return rows.map((r) => ({
    key: `${group}:${r.name}`,
    group,
    label: r.name,
    hint: count(r.count),
    href: galleryHref(
      group === "loras" ? { lora: [r.name] } : group === "embeddings" ? { embedding: [r.name] } : { model: r.name },
    ),
  }));
}

/** How well `query` matches an item: its best text, or null. `_` and space
 * are one (`blue_eyes` = `blue eyes`). Letters strewn across a long name
 * ("hair" in "Hu Tao, rainy street") don't count: below two points a letter,
 * a match is noise when every list in the app is searched at once. */
const matchTexts = new WeakMap<SearchItem, string[]>();

function score(query: string, item: SearchItem): number | null {
  let texts = matchTexts.get(item);
  if (!texts) {
    texts = [item.label, ...(item.also ?? [])].map(tagQueryText);
    matchTexts.set(item, texts);
  }
  let best: number | null = null;
  for (const text of texts) {
    const s = fuzzyScore(query, text);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best !== null && best >= query.replace(/ /g, "").length * 2 ? best : null;
}

/**
 * Sections for `query`: each group's best matches, the group with the
 * strongest match first. Empty, only `pages` and the newest generations
 * (where people go most), in their own order.
 */
export function searchSections(query: string, items: readonly SearchItem[]): SearchSection[] {
  const q = tagQueryText(query.trim());
  const by = new Map<SearchGroup, { item: SearchItem; s: number; i: number }[]>();
  items.forEach((item, i) => {
    if (!q && item.group !== "pages" && item.group !== "generations") return;
    const s = q ? score(q, item) : 0;
    if (s === null) return;
    const list = by.get(item.group) ?? [];
    list.push({ item, s, i });
    by.set(item.group, list);
  });
  const sections = [...by.entries()].map(([group, list]) => {
    list.sort((a, b) => b.s - a.s || a.i - b.i);
    const limit = q ? LIMIT[group] : group === "generations" ? 3 : list.length;
    return { group, items: list.slice(0, limit).map((x) => x.item), best: list[0].s };
  });
  sections.sort((a, b) => b.best - a.best || ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  return sections.map(({ group, items }) => ({ group, items }));
}
