// Generation metadata + curation as the frontend sees them. The structured
// `gen.*` fields are extracted server-side (see services/gen_metadata.py); copy
// of the original workflow is fetched on demand from the cold raw collection.

export type GenMeta = {
  source?: string | null;
  workflow_sig?: string | null;
  prompt?: string | null;
  negative?: string | null;
  seed?: number | null;
  model?: string | null;
  sampler?: string | null;
  steps?: number | null;
  cfg?: number | null;
  prompt_terms?: string[];
  /** Each prompt term's weight, as the source tool read its emphasis; only
   * terms not at 1 (services/gen_metadata.py prompt_weights). */
  prompt_weights?: Record<string, number>;
  /** Loras the image was generated with (services/gen_metadata.py). */
  loras?: { name: string; strength: number | null }[];
  /** Embeddings named in the prompt or the negative prompt. */
  embeddings?: { name: string; negative: boolean }[];
  group_id?: string | null;
  /** Fields the graph didn't give up, guessed by keywords instead
   * (services/prompt_guess.py). */
  guessed?: ("prompt" | "negative")[];
  /** Where each guess came from, as a pinnable path (null when unknown). */
  guess_paths?: Partial<Record<"prompt" | "negative", string | null>>;
};
