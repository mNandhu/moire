// The Global Sensitivity Filter's setting and this library's tag levels.
// Changing either changes what every list holds, so both refetch everything.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, apiJson, ApiError } from "../api";
import type { Rating } from "../rating";
import type { FilterLevel, SensitivityState, TagLevels } from "../sensitivity";

export const SENSITIVITY_KEY = ["sensitivity"] as const;
const TAG_LEVELS_KEY = [...SENSITIVITY_KEY, "tags"] as const;

/** `poll`: refetch every few seconds (an AI job is giving hidden images a
 * level, so the counts move). */
export function useSensitivity({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: SENSITIVITY_KEY,
    queryFn: ({ signal }) => api<SensitivityState>("/api/v1/sensitivity", { signal }),
    staleTime: 30_000,
    refetchInterval: poll ? 3000 : false,
  });
}

export function useTagLevels() {
  return useQuery({
    queryKey: TAG_LEVELS_KEY,
    queryFn: ({ signal }) => api<TagLevels>("/api/v1/sensitivity/tags", { signal }),
  });
}

/** Set the filter's maximum (null: off). Every cached list was read under the
 * old setting, so all of it refetches. */
export async function setFilterLevel(qc: QueryClient, max: FilterLevel | null): Promise<void> {
  const state = await apiJson<SensitivityState>("/api/v1/sensitivity", "POST", { max_level: max });
  qc.setQueryData(SENSITIVITY_KEY, state);
  await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== SENSITIVITY_KEY[0] });
  await qc.invalidateQueries({ queryKey: TAG_LEVELS_KEY });
}

/** Set (or with null, drop) this library's level for a tag. Images change
 * level with it, so everything refetches. */
export async function setTagLevel(qc: QueryClient, tag: string, level: Rating | null): Promise<void> {
  await apiJson("/api/v1/sensitivity/tags", "POST", { tag, level });
  await qc.invalidateQueries();
}

/** An image route's answer for an image the filter hides. */
export const isHiddenBySensitivity = (e: unknown): boolean => e instanceof ApiError && e.status === 403;
