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
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  NO_BOILERPLATE,
  compileBoilerplate,
  type BoilerplateMatcher,
} from "./boilerplate";
import { api } from "./api";
import { fetchAiCoverage } from "./ai";

export type Library = {
  _id: string;
  name?: string;
  path: string;
  indexed_count?: number;
  last_scanned?: string;
  watch_enabled?: boolean;
  last_event_at?: string | null;
  scanning?: boolean;
};

export const LIBRARIES_KEY = ["libraries"] as const;

export function fetchLibraries(signal?: AbortSignal): Promise<Library[]> {
  return api<Library[]>("/api/v1/libraries", { signal });
}

/** All libraries; polls while any of them is scanning so counts stay live. */
export function useLibraries() {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: ({ signal }) => fetchLibraries(signal),
    refetchInterval: (q) =>
      q.state.data?.some((l) => l.scanning) ? 3000 : false,
  });
}

export type TagAgg = { _id: string; count: number };

/** Prefix for every tag-aggregate query; invalidate this after tag writes. */
export const TAGS_KEY = ["tags"] as const;

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
