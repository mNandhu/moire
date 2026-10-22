/**
 * Shared server-state queries for data more than one page reads.
 *
 * Overview, Libraries, Tags and the gallery each used to fetch libraries and
 * the tag aggregate in their own `useEffect` into local state, so every visit
 * started from nothing and flashed a loading state. Reading them through one
 * TanStack cache makes moving between pages instant and keeps them in step:
 * a write invalidates the key once and every reader refreshes.
 */

import { viewerTimeZone } from "./activity";
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  NO_BOILERPLATE,
  compileBoilerplate,
  type BoilerplateMatcher,
} from "./boilerplate";
import { api } from "./api";
import { descriptionKey } from "./tags";
import { fetchAiCoverage } from "./ai";
import type { BrowseTag, TagDetail, TagSource } from "./tagBrowse";
import type { CharacterPage } from "./character";
import type { Facet } from "./tagColour";

export type Library = {
  _id: string;
  name?: string;
  path: string;
  indexed_count?: number;
  last_scanned?: string;
  watch_enabled?: boolean;
  last_event_at?: string | null;
  scanning?: boolean;
  /** Being deleted: shown until it's gone. */
  deleting?: boolean;
  /** Scan progress. Both stay 0 while the scan is queued or still listing files. */
  scan_total?: number;
  scan_done?: number;
};

/** "Scanning", with a percentage once the scan knows how many files it has. */
export function scanLabel(l: Library): string {
  if (!l.scan_total) return "Scanning…";
  const pct = Math.floor(((l.scan_done ?? 0) / l.scan_total) * 100);
  return `Scanning ${Math.min(pct, 99)}%`;
}

/** The gallery showing one library. */
export const libraryGalleryHref = (id: string) => `/?${new URLSearchParams({ library_id: id })}`;

/** The Libraries page with one library picked out (scrolled to, its folders open). */
export const libraryPageHref = (id: string) => `/libraries?${new URLSearchParams({ library: id })}`;

export const LIBRARIES_KEY = ["libraries"] as const;

export function fetchLibraries(signal?: AbortSignal): Promise<Library[]> {
  return api<Library[]>("/api/v1/libraries", { signal });
}

/** The versioned thumbnail URL of an image known only by id (a cover picked
 * in a dialog, the image a remix came from); lists carry theirs. */
export function useThumbUrl(imageId: string | null | undefined): string | null {
  const { data } = useQuery({
    // Not under ["images"]: that prefix is the feeds', which feedCache patches.
    queryKey: ["thumb-url", imageId],
    queryFn: ({ signal }) =>
      api<{ thumb_url: string }>(`/api/v1/images/${encodeURIComponent(imageId!)}/thumb-url`, { signal }),
    enabled: !!imageId,
    staleTime: 60_000,
  });
  return imageId ? (data?.thumb_url ?? null) : null;
}

/** All libraries; polls while any of them is scanning so counts stay live.
 * `poll: false` for a reader that only needs names (the gallery underneath
 * already keeps the list fresh). */
export function useLibraries({ poll = true } = {}) {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: ({ signal }) => fetchLibraries(signal),
    refetchInterval: (q) =>
      poll && q.state.data?.some((l) => l.scanning || l.deleting) ? 3000 : false,
  });
}

type Used = { name: string; count: number }[];

/** Checkpoints, embeddings and loras the library's images used, with counts
 * (the gallery's filters and the Ctrl/Cmd+K search). */
export const imageModelsQuery = {
  queryKey: ["image-models"],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<{ model: string; count: number }[]>(`/api/v1/images/models`, { signal }),
};
export const imageEmbeddingsQuery = {
  queryKey: ["image-embeddings"],
  queryFn: ({ signal }: { signal: AbortSignal }) => api<Used>(`/api/v1/images/embeddings`, { signal }),
};
export const imageLorasQuery = {
  queryKey: ["image-loras"],
  queryFn: ({ signal }: { signal: AbortSignal }) => api<Used>(`/api/v1/images/loras`, { signal }),
};

export type TagAgg = { _id: string; count: number };

/** Prefix for every tag-aggregate query; invalidate this after tag writes. */
export const TAGS_KEY = ["tags"] as const;

// The attire and facet maps change only with the library's tags, and any tag
// write invalidates them (TAGS_KEY), so they can live long; the server keeps
// them built until a write, so a refetch is cheap.
const TAG_MAP_STALE_MS = 10 * 60_000;

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

export const AI_COVERAGE_KEY = ["aiCoverage"] as const;

/**
 * How much of the library carries AI tags. Overview, Tags and AI Tagging all
 * read it; `busy` (a job running) tightens the poll so numbers track progress.
 */
export function useAiCoverage({ busy = false } = {}) {
  return useQuery({
    queryKey: AI_COVERAGE_KEY,
    queryFn: ({ signal }) => fetchAiCoverage(signal),
    refetchInterval: busy ? 3000 : 15000,
  });
}

export type ImageStats = {
  activity: import("./activity").DayCount[];
  quarantined: number;
};

export const IMAGE_STATS_KEY = ["image-stats"] as const;

/** Overview numbers: images per local day for the past year, and the
 * quarantine backlog. */
export function useImageStats() {
  return useQuery({
    queryKey: IMAGE_STATS_KEY,
    // A year of activity barely moves between visits; mutations that change
    // the quarantine count invalidate it (feedCache.invalidateFeeds).
    staleTime: 60_000,
    queryFn: ({ signal }) =>
      api<ImageStats>(
        // The offset is a fallback for a zone the server doesn't know.
        `/api/v1/images/stats?days=371&tz=${encodeURIComponent(viewerTimeZone())}` +
          `&tz_offset=${-new Date().getTimezoneOffset()}`,
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

export const TAG_FACETS_KEY = [...TAGS_KEY, "facets"] as const;

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

export type TagSettings = {
  boilerplate: string[];
  default_boilerplate: string[];
};

export const TAG_SETTINGS_KEY = ["tag-settings"] as const;

export function useTagSettings() {
  return useQuery({
    queryKey: TAG_SETTINGS_KEY,
    queryFn: ({ signal }) => api<TagSettings>("/api/v1/tags/settings", { signal }),
    staleTime: 5 * 60_000,
  });
}

export function saveTagSettings(boilerplate: string[]): Promise<TagSettings> {
  return api<TagSettings>("/api/v1/tags/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boilerplate }),
  });
}

export type GuessKeywords = {
  guess_positive: string[];
  guess_negative: string[];
  default_positive: string[];
  default_negative: string[];
  /** Images whose prompt or negative is currently a guess. */
  guessed_images: number;
};

export const GUESS_KEYWORDS_KEY = ["guess-keywords"] as const;

export function useGuessKeywords() {
  return useQuery({
    queryKey: GUESS_KEYWORDS_KEY,
    queryFn: ({ signal }) => api<GuessKeywords>("/api/v1/rules/guess-keywords", { signal }),
  });
}

/** Saving re-reads every image's prompt in the background. */
export function saveGuessKeywords(positive: string[], negative: string[]): Promise<GuessKeywords> {
  return api<GuessKeywords>("/api/v1/rules/guess-keywords", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guess_positive: positive, guess_negative: negative }),
  });
}

/** The boilerplate matcher from Settings; matches nothing until loaded (or
 * when the backend answers with something else, e.g. one without the route). */
export function useBoilerplate(): BoilerplateMatcher {
  const { data } = useTagSettings();
  return useMemo(
    () =>
      Array.isArray(data?.boilerplate) ? compileBoilerplate(data.boilerplate) : NO_BOILERPLATE,
    [data],
  );
}

// --- Tag rename / merge -------------------------------------------------------

export type TagAlias = { from: string; to: string; created_at: number | null };
export type TagRenameResult = { kind: "manual" | "prompt"; from: string; to: string; images: number };

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
  return api<TagRenameResult>("/api/v1/tags/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag, to }),
  });
}

export function deleteTagAlias(from: string): Promise<{ from: string; to: string; images: number }> {
  return api(`/api/v1/tags/aliases/${encodeURIComponent(from)}`, { method: "DELETE" });
}

// --- Prompt board ---------------------------------------------------------------

/** A part of the scene a prompt tag sets (services/prompt_board.py SECTIONS). */
export type BoardSection =
  | "subject"
  | "hair"
  | "eyes"
  | "expression"
  | "body"
  | "attire"
  | "pose"
  | "framing"
  | "background"
  | "lighting"
  | "style"
  | "other"
  | "quality"
  | "unknown";

export type TagPlace = {
  section: BoardSection;
  group?: string;
  category?: string;
  also?: string[];
  /** The tag this name is a Danbooru alias of. */
  alias_of?: string;
  /** Danbooru posts with it. */
  posts?: number;
};

export type TagPlaces = {
  names: Record<string, TagPlace>;
  /** Danbooru's list is in: until then nothing reads as unknown. */
  list: boolean;
  /** It is being downloaded. */
  fetching: boolean;
};

/** Where each tag goes on the prompt board. Asked once typing pauses; the
 * last answer stays up meanwhile so the board doesn't flicker. */
export function useTagPlaces(names: readonly string[]) {
  const joined = [...new Set(names)].sort().join("\n");
  const [asked, setAsked] = useState(joined);
  useEffect(() => {
    const id = window.setTimeout(() => setAsked(joined), 200);
    return () => window.clearTimeout(id);
  }, [joined]);
  return useQuery({
    queryKey: [...TAGS_KEY, "place", asked],
    queryFn: ({ signal }) =>
      api<TagPlaces>("/api/v1/tags/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names: asked ? asked.split("\n") : [] }),
        signal,
      }),
    enabled: asked !== "",
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    // The list is fetched on first use: ask again while it downloads.
    refetchInterval: (q) => (q.state.data?.fetching ? 10_000 : false),
  });
}

/** What each board section suggests: `[tag, Danbooru posts]`, most posted
 * first, the library's own tags among them. */
export function useBoardOffers({ enabled = true, list }: { enabled?: boolean; list?: boolean } = {}) {
  return useQuery({
    // Asked again once Danbooru's list is in: it ranks and sorts them.
    queryKey: [...TAGS_KEY, "board", list ?? false],
    queryFn: ({ signal }) => api<Partial<Record<BoardSection, [string, number][]>>>("/api/v1/tags/board", { signal }),
    enabled,
    staleTime: TAG_MAP_STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/** `tag -> one-sentence description` for the tagger's general tags: a file
 * shipped with the app (and its Danbooru aliases). Not under TAGS_KEY,
 * which every tag write invalidates. */
export function useTagDescriptions() {
  return useQuery({
    queryKey: ["tag-descriptions"],
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
