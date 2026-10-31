// Image-wide reads: an image's versioned thumbnail URL, what the library's
// images used (checkpoints, loras, embeddings), the Overview numbers and AI
// coverage.

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { imageUrl } from "../media";
import { viewerTimeZone } from "../activity";
import { fetchAiCoverage } from "../ai";

export const THUMB_URL_KEY = ["thumb-url"] as const;

/** The versioned thumbnail URL of an image known only by id (a cover picked
 * in a dialog, the image a remix came from); lists carry theirs. */
export function useThumbUrl(imageId: string | null | undefined): string | null {
  const { data } = useQuery({
    // Not under ["images"]: that prefix is the feeds', which feedCache patches.
    queryKey: [...THUMB_URL_KEY, imageId],
    queryFn: ({ signal }) =>
      api<{ thumb_url: string }>(imageUrl(imageId!, "thumb-url"), { signal }),
    enabled: !!imageId,
    staleTime: 60_000,
  });
  return imageId ? (data?.thumb_url ?? null) : null;
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
  activity: import("../activity").DayCount[];
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
