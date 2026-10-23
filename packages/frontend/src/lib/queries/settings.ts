// Tag settings (prompt boilerplate) and the guess keywords Rules reads
// prompts with.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, apiJson } from "../api";
import { NO_BOILERPLATE, compileBoilerplate, type BoilerplateMatcher } from "../boilerplate";

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
  return apiJson<TagSettings>("/api/v1/tags/settings", "POST", { boilerplate });
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
  return apiJson<GuessKeywords>("/api/v1/rules/guess-keywords", "PUT", {
    guess_positive: positive,
    guess_negative: negative,
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
