// The prompt board: where each prompt tag goes and what each section offers.

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, apiJson } from "../api";
import { TAGS_KEY, TAG_MAP_STALE_MS } from "./tags";

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
  | "library"
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
      apiJson<TagPlaces>("/api/v1/tags/place", "POST", { names: asked ? asked.split("\n") : [] }, { signal }),
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
