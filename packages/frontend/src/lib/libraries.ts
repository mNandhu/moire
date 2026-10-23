/**
 * Libraries on the frontend: the type, the one shared list query (and its
 * poller), the scan helpers, and every library API call.
 *
 * Every write goes through `useLibraryWrites`, which refreshes the list and the
 * gallery's image caches the same way whichever page made the change.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, apiJson, errorText } from "./api";
import { IMAGE_FEED_PREFIX, IMAGE_GROUPS_PREFIX } from "./imageApi";
import { galleryHref } from "./imageFilter";

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
  /** Why the last scan failed, or a note about what it kept. */
  scan_error?: string | null;
};

/** "Scanning", with a percentage once the scan knows how many files it has. */
export function scanLabel(l: Library): string {
  if (!l.scan_total) return "Scanning…";
  const pct = Math.floor(((l.scan_done ?? 0) / l.scan_total) * 100);
  return `Scanning ${Math.min(pct, 99)}%`;
}

/** The last scan's failure, or its note about what it kept (`note`: the scan
 * finished; the notes are scanner.py's "Kept ..." and "Some folders ...").
 * Nothing while scanning or after a cancel. */
export function scanProblem(l: Library): { text: string; note: boolean } | null {
  if (l.scanning || !l.scan_error || l.scan_error === "cancelled") return null;
  const text = l.scan_error;
  return { text, note: text.startsWith("Kept ") || text.startsWith("Some folders could not be read") };
}

/** The gallery showing one library. */
export const libraryGalleryHref = (id: string) => galleryHref({ libraryId: id });

/** The Libraries page with one library picked out (scrolled to, its folders open). */
export const libraryPageHref = (id: string) => `/libraries?${new URLSearchParams({ library: id })}`;

export const LIBRARIES_KEY = ["libraries"] as const;

/** How often the list is refetched while anything scans or is being deleted. */
export const SCAN_POLL_MS = 2000;

/** The refetch interval for a library list: brisk while a library scans or is
 * being deleted, else `idleMs` (false: not at all). */
export function libraryPollMs(libs: Library[] | undefined, idleMs: number | false = false): number | false {
  return libs?.some((l) => l.scanning || l.deleting) ? SCAN_POLL_MS : idleMs;
}

/** Did a library go from scanning to done between two reads of the list? */
export function scanFinished(prev: Library[] | undefined, next: Library[]): boolean {
  if (!prev) return false;
  const now = new Map(next.map((l) => [l._id, l]));
  return prev.some((l) => l.scanning && now.has(l._id) && !now.get(l._id)!.scanning);
}

/** Should the gallery's feed be refetched after this read of the list? While a
 * scan runs, once more after it ends (the final batch only shows up then), and
 * when the watcher reports a new event. The first read always does one pull. */
export function feedNeedsRefetch(prev: Library[] | undefined, next: Library[]): boolean {
  if (!prev) return true;
  if (next.some((l) => l.scanning) || prev.some((l) => l.scanning)) return true;
  const seen = new Map(prev.map((l) => [l._id, l.last_event_at]));
  return next.some((l) => !!l.last_event_at && l.last_event_at !== seen.get(l._id));
}

export function fetchLibraries(signal?: AbortSignal): Promise<Library[]> {
  return api<Library[]>("/api/v1/libraries", { signal });
}

/** All libraries, the one poller for scan state. Brisk while any scans so
 * counts stay live; `idleMs` keeps a slow poll otherwise (the gallery, to
 * catch scans and watcher events started elsewhere). `poll: false` for a reader
 * that only needs names (the gallery underneath already keeps the list fresh). */
export function useLibraries({ poll = true, idleMs = false }: { poll?: boolean; idleMs?: number | false } = {}) {
  return useQuery({
    queryKey: LIBRARIES_KEY,
    queryFn: ({ signal }) => fetchLibraries(signal),
    refetchInterval: (q) => (poll ? libraryPollMs(q.state.data, idleMs) : false),
  });
}

/** Calls `fn(previous, next)` after every read of the list, `previous` being
 * the one before (undefined on the first). Derives scan transitions from query
 * data instead of a second poller. */
export function useOnLibrariesRead(
  query: Pick<UseQueryResult<Library[]>, "data" | "dataUpdatedAt">,
  fn: (prev: Library[] | undefined, next: Library[]) => void,
) {
  const last = useRef<Library[] | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const { data, dataUpdatedAt } = query;
  useEffect(() => {
    if (!data) return;
    const prev = last.current;
    last.current = data;
    fnRef.current(prev, data);
    // dataUpdatedAt, not data alone: a read that changed nothing is still a tick.
  }, [data, dataUpdatedAt]);
}

/** Library changes alter which images the gallery should show. Both the flat
 * feed (`["images", ...]`) and the batch-collapsed grouped view
 * (`["image-groups", ...]`) are cached with a staleTime, so without this the
 * gallery serves stale results (including images of a removed library). */
export function invalidateImageCaches(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: IMAGE_FEED_PREFIX });
  void qc.invalidateQueries({ queryKey: IMAGE_GROUPS_PREFIX });
}

/** The one rule after any library write: the list and the gallery refetch. */
export function invalidateLibraryData(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: LIBRARIES_KEY });
  invalidateImageCaches(qc);
}

const libraryUrl = (id: string) => `/api/v1/libraries/${encodeURIComponent(id)}`;

export type NewLibrary = { path: string; name?: string };

/** The create/edit/delete/rescan calls; each refreshes the caches when it
 * settles, success or not (a failed delete may still have changed things). */
export function useLibraryWrites() {
  const qc = useQueryClient();
  return useMemo(() => {
    const write = async <T,>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } finally {
        invalidateLibraryData(qc);
      }
    };
    return {
      create: (item: NewLibrary) => write(() => apiJson<{ _id: string }>("/api/v1/libraries", "POST", item)),
      update: (id: string, patch: Partial<Library>) => write(() => apiJson<unknown>(libraryUrl(id), "PATCH", patch)),
      remove: (id: string) => write(() => api<unknown>(libraryUrl(id), { method: "DELETE" })),
      rescan: (id: string) => write(() => api<unknown>(`${libraryUrl(id)}/rescan`, { method: "POST" })),
      /** One at a time (each POST is cheap, the scan runs in the background,
       * and per-row errors stay attributable). A failure doesn't stop the rest. */
      async createMany(items: NewLibrary[]) {
        const created: Record<string, string> = {};
        const failed: { path: string; error: string }[] = [];
        try {
          for (const item of items) {
            try {
              created[item.path] = (await apiJson<{ _id: string }>("/api/v1/libraries", "POST", item))._id;
            } catch (e) {
              failed.push({ path: item.path, error: errorText(e) });
            }
          }
        } finally {
          invalidateLibraryData(qc);
        }
        return { created, failed };
      },
    };
  }, [qc]);
}
