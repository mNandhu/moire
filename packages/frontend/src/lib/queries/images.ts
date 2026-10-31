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

/** A facet list counted over one gallery view: the default feed, or with
 * `quarantined` the Quarantined view (as the feed filters). Both keys sit
 * under `[key]`, so invalidating that refreshes either. */
const facetQuery =
  <T,>(key: string, path: string) =>
  (quarantined = false) => ({
    queryKey: quarantined ? [key, "quarantined"] : [key],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<T>(quarantined ? `${path}?quarantined=1` : path, { signal }),
  });

/** Checkpoints, embeddings and loras the library's images used, with counts
 * (the gallery's filters and the Ctrl/Cmd+K search). The `...In` forms take
 * the gallery's quarantine filter. */
export const imageModelsQueryIn = facetQuery<{ model: string; count: number }[]>(
  "image-models",
  "/api/v1/images/models",
);
export const imageEmbeddingsQueryIn = facetQuery<Used>("image-embeddings", "/api/v1/images/embeddings");
export const imageLorasQueryIn = facetQuery<Used>("image-loras", "/api/v1/images/loras");
export const imageModelsQuery = imageModelsQueryIn();
export const imageEmbeddingsQuery = imageEmbeddingsQueryIn();
export const imageLorasQuery = imageLorasQueryIn();

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
