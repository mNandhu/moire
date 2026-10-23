// Tag aggregates and per-tag reads (browse, detail, character pages, the
// attire/facet/group maps), tag rename / merge rules and tag descriptions.
// Everything under TAGS_KEY refreshes after any tag write.

import { useQuery } from "@tanstack/react-query";
import { api, apiJson } from "../api";
import { descriptionKey } from "../tags";
import type { BrowseTag, TagDetail, TagSource } from "../tagBrowse";
import type { CharacterPage } from "../character";
import type { Facet } from "../tagColour";
import type { TagGroups } from "../tagGroups";

export type TagAgg = { _id: string; count: number };

/** Prefix for every tag-aggregate query; invalidate this after tag writes. */
export const TAGS_KEY = ["tags"] as const;

// The attire and facet maps change only with the library's tags, and any tag
// write invalidates them (TAGS_KEY), so they can live long; the server keeps
// them built until a write, so a refetch is cheap.
export const TAG_MAP_STALE_MS = 10 * 60_000;

/**
 * The tag aggregate (AI + manual, optionally prompt tags). The backend caches
 * this for ~30s, so the default staleTime matches it.
 */
export function useTagAggregate({ includePrompt = false } = {}) {
  return useQuery({
    queryKey: [...TAGS_KEY, { includePrompt }],
    queryFn: ({ signal }) =>
      api<TagAgg[]>(
        `/api/v1/tags?include_manual=1${includePrompt ? "&include_prompt=1" : ""}`,
        { signal },
      ),
  });
}

/** Every tag with its three sources (AI / manual / prompt) collapsed into one
 * cross-source `any:<base>` row, the count distinct images: the gallery
 * search's suggestions. */
export const mergedTagsQuery = {
  queryKey: [...TAGS_KEY, { merged: true }],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<TagAgg[]>(`/api/v1/tags?include_manual=1&include_prompt=1&merge_sources=1`, { signal }),
};

/** The Tags page list: one entry per tag name, optionally from one source.
 * Under TAGS_KEY, so every tag write refreshes it. */
export function useTagBrowse(source: TagSource, { enabled = true, staleTime = 0 } = {}) {
  return useQuery({
    staleTime,
    queryKey: [...TAGS_KEY, "browse", source],
    queryFn: ({ signal }) =>
      api<BrowseTag[]>(`/api/v1/tags/browse?source=${source}`, { signal }),
    enabled,
  });
}

/** A character page's query, for one (useCharacterPage) or several. */
export const characterPageQuery = (tag: string) => ({
  queryKey: [...TAGS_KEY, "character", tag],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<CharacterPage>(`/api/v1/tags/character?${new URLSearchParams({ tag })}`, { signal }),
  retry: false,
});

/** A character page, by any of the character's names. Under TAGS_KEY, so
 * every tag write (a new cover, a setting) refreshes it. */
export function useCharacterPage(tag: string) {
  return useQuery(characterPageQuery(tag));
}

/** The Tags page panel for one tag; idle while `tag` is null. */
export function useTagDetail(tag: string | null, source: TagSource) {
  return useQuery({
    queryKey: [...TAGS_KEY, "detail", tag, source],
    enabled: tag !== null,
    queryFn: ({ signal }) =>
      api<TagDetail>(
        `/api/v1/tags/detail?${new URLSearchParams({ tag: tag ?? "", source })}`,
        { signal },
      ),
  });
}

/** `tag -> attire group` (headwear, accessories, ...): outfit chips are
 * labelled by it. Covers the library's own tags, so it sits under TAGS_KEY
 * and refreshes after tag writes. */
export function useAttireGroups() {
  return useQuery({
    queryKey: [...TAGS_KEY, "attire"],
    queryFn: ({ signal }) => api<Record<string, string>>("/api/v1/tags/attire", { signal }),
    staleTime: TAG_MAP_STALE_MS,
    gcTime: TAG_MAP_STALE_MS,
  });
}

const TAG_FACETS_KEY = [...TAGS_KEY, "facets"] as const;

/** `tag -> facet` from the shipped tag-group list plus the library's garments;
 * under TAGS_KEY like the attire map. */
export function useTagFacets() {
  return useQuery({
    queryKey: TAG_FACETS_KEY,
    queryFn: ({ signal }) => api<Record<string, Facet>>("/api/v1/tags/facets", { signal }),
    staleTime: TAG_MAP_STALE_MS,
    gcTime: TAG_MAP_STALE_MS,
  });
}

const TAG_GROUPS_KEY = [...TAGS_KEY, "groups"] as const;

/** The library's tags by tag group (lib/tagGroups.ts), for the group pages. */
export function useTagGroups() {
  return useQuery({
    queryKey: TAG_GROUPS_KEY,
    queryFn: ({ signal }) => api<TagGroups>("/api/v1/tags/groups", { signal }),
    staleTime: TAG_MAP_STALE_MS,
    gcTime: TAG_MAP_STALE_MS,
  });
}

// --- Tag rename / merge -------------------------------------------------------

/** A merge rule (`to` one name) or a split (several), services/tag_rename.py. */
export type TagAlias = { from: string; to: string[]; created_at: number | null };
export type TagRenameResult = {
  kind: "manual" | "prompt";
  from: string;
  to: string;
  /** A prompt merge onto a split name: every name it now stands for. */
  to_all?: string[];
  images: number;
  /** A prompt merge on many images: they are updated in the background. */
  background?: boolean;
};

export const TAG_ALIASES_KEY = ["tag-aliases"] as const;

/** Prompt-tag merge rules (services/tag_rename.py), newest first. */
export function useTagAliases() {
  return useQuery({
    queryKey: TAG_ALIASES_KEY,
    queryFn: ({ signal }) => api<TagAlias[]>("/api/v1/tags/aliases", { signal }),
  });
}

/** Rename a manual tag, or merge a prompt tag (stored as a rule). `tag` is the
 * stored form, prefix included; `to` a bare name. */
export function renameTag(tag: string, to: string): Promise<TagRenameResult> {
  return apiJson<TagRenameResult>("/api/v1/tags/rename", "POST", { tag, to });
}

export function deleteTagAlias(
  from: string,
): Promise<{ from: string; to: string[]; images: number; background?: boolean }> {
  return api(`/api/v1/tags/aliases/${encodeURIComponent(from)}`, { method: "DELETE" });
}

/** Store several merge / split rules at once. A rule that would loop is skipped. */
export function addTagRules(
  rules: { from: string; to: string[] }[],
): Promise<{
  rules: number;
  skipped: { from: string; reason: string }[];
  images: number;
  /** Many images: they are updated in the background (shown as activity). */
  background: boolean;
}> {
  return apiJson("/api/v1/tags/aliases", "POST", { rules });
}

/** How a suggestion reads the prompt tag (services/tag_canon.py stages). */
export type MergeKind = "alias" | "respell" | "colour" | "split" | "strip";
export type MergeSuggestion = { from: string; to: string[]; kind: MergeKind; images: number };
type MergeSuggestions = { available: boolean; suggestions: MergeSuggestion[] };

export const MERGE_SUGGESTIONS_KEY = ["merge-suggestions"] as const;

/** Prompt tags Danbooru names otherwise, most used first. Empty until the
 * server has Danbooru's list (the prompt board downloads it). Costly to
 * build and slow to change, so not refetched on every visit; a rule write
 * invalidates it. */
export function useMergeSuggestions() {
  return useQuery({
    queryKey: MERGE_SUGGESTIONS_KEY,
    queryFn: ({ signal }) => api<MergeSuggestions>("/api/v1/tags/merge-suggestions", { signal }),
    staleTime: 5 * 60_000,
  });
}

export const TAG_DESCRIPTIONS_KEY = ["tag-descriptions"] as const;

/** `tag -> one-sentence description` for the tagger's general tags: a file
 * shipped with the app (and its Danbooru aliases). Not under TAGS_KEY,
 * which every tag write invalidates. */
export function useTagDescriptions() {
  return useQuery({
    queryKey: TAG_DESCRIPTIONS_KEY,
    queryFn: ({ signal }) => api<Record<string, string>>("/api/v1/tags/descriptions", { signal }),
    // Aliases join once the server has Danbooru's list, so look again now and then.
    staleTime: TAG_MAP_STALE_MS,
    gcTime: Infinity,
  });
}

/** One tag's description (any spelling: prefixed, spaced, any case), if it has one. */
export function useTagDescription(tag: string | null | undefined): string | undefined {
  const { data } = useTagDescriptions();
  return tag ? data?.[descriptionKey(tag)] : undefined;
}
