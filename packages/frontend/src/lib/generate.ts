/**
 * Generation (ComfyUI) API: types, fetchers and the polled queries. The
 * browser never talks to ComfyUI; everything goes through `/api/v1/generate`.
 */
import { testState } from "./generatorRunBar";
import { keepPreviousData, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { api, apiJson, httpError, jsonInit } from "./api";
import type { NewEstimate } from "./eta";

const BASE = "/api/v1/generate";

export type ComfySettings = {
  address: string;
  /** Header names with masked values; send the mask back to keep a value. */
  headers: Record<string, string>;
  output_library_id: string | null;
  output_path: string | null;
  builtin_per_request: number;
  /** PEM file verifying an HTTPS ComfyUI with a self-signed certificate. */
  ca_cert: string;
  /** Fetch finished images from ComfyUI when they aren't in the output folder. */
  download_outputs: boolean;
  /** ComfyUI's own output folder as Moiré sees it (found from the first
   * output a library holds); "" until known. */
  output_root: string;
  /** What a character picked in Generate starts wearing. */
  new_character_outfit: "none" | "default";
};

export const HEADER_MASK = "••••";

export type Progress = { value: number; max: number; node?: string } | null;

export type ActiveBatch = {
  _id: number;
  name: string;
  test: boolean;
  state: BatchState;
  requests: number;
  finished: number;
  failed: number;
  progress: Progress;
  /** Seconds left on it; null when some request has no estimate. */
  eta?: number | null;
  /** ComfyUI is making one of its images now. */
  running?: boolean;
  /** Seconds until its first image starts and its last is done, its turns
   * among the other batches counted; null when some estimate is missing. */
  starts_in?: number | null;
  done_in?: number | null;
  width?: number | null;
  height?: number | null;
  /** One per image asked, in request order, with its thumbnail once in the library. */
  frames?: QueueFrame[];
};

export type QueueFrame = { state: "done" | "failed" | "cancelled" | "making" | "waiting"; thumb: string | null };

export type ComfyStatus = {
  configured: boolean;
  connected: boolean;
  error: string | null;
  busy: boolean;
  queue_remaining: number;
  active: ActiveBatch[];
  /** Seconds left on the whole queue; null when some of it can't be told. */
  eta?: number | null;
};

export type LoraMatch = { stem: string; images: number; files: string[]; name: string | null };

export type ComfyModels = {
  checkpoints: string[];
  loras: string[];
  embeddings: string[];
  /** ComfyUI's samplers and schedulers, in its order. */
  samplers: string[];
  schedulers: string[];
  matching: LoraMatch[];
};

export type GeneratorTest = {
  batch_id: number;
  state: RequestState;
  error: RequestError | null;
  progress: Progress;
  outputs: number;
  image_id: string | null;
};

export type Generator = {
  _id: string;
  name: string;
  kind: "builtin" | "custom";
  ready: boolean;
  slots: GeneratorSlots;
  /** The graph's own value for each sampling setting it exposes. */
  sampling: Sampling;
  /** Where a custom Generator came from (null for the built-in). */
  source: GeneratorOrigin | null;
  /** A custom Generator's own prompt, from its source. */
  defaults: { base: string; negative: string } | null;
  /** What the workflow sets itself where Moiré has no slot (shown read-only). */
  fixed: { checkpoint: string | null; size: string | null };
  /** The checkpoint slot's own value: what a remix into it starts on. */
  checkpoint_default: string | null;
  test: GeneratorTest | null;
};

/** ``[node id, input name]`` in the Generator's graph. */
export type SlotPath = [string, string];
/** ``[node id, output index]``: where Moiré's LoRA chain starts. */
export type OutputRef = [string, number];

export type GeneratorSlots = Partial<{
  positive: SlotPath;
  negative: SlotPath;
  /** Prompt slots whose path is a link Moiré overwrites (a run-time join). */
  replace_links: ("positive" | "negative")[];
  seeds: SlotPath[];
  width: SlotPath;
  height: SlotPath;
  batch_size: SlotPath;
  per_request: number;
  checkpoint: SlotPath;
  sampler: SlotPath;
  scheduler: SlotPath;
  steps: SlotPath;
  cfg: SlotPath;
  lora_model: OutputRef;
  lora_clip: OutputRef | null;
  /** No insertion point: LoRAs go into the positive prompt as `<lora:name:strength>`. */
  lora_text: boolean;
  /** The workflow's own LoRA loaders left out (not on the connected ComfyUI). */
  drop_loras: string[];
}>;

export type GeneratorOrigin =
  | {
      kind: "image";
      image_id: string;
      family: string | null;
      family_name: string | null;
      /** The imported workflow file an unnamed family matches. */
      file_name?: string | null;
      workflow_sig: string | null;
    }
  | { kind: "upload"; filename: string | null };

/** What setup is given: a library image, or an uploaded Export (API) file. */
export type GeneratorSourceIn = { image_id: string } | { graph: unknown; filename?: string };

export type NodeRef = { node: string; title: string };

export type FoundPrompt = { path: SlotPath; replaces_link: boolean; text?: string | null; from?: "rule" };

export type TextInput = {
  path: SlotPath;
  class_type: string;
  title: string;
  text: string | null;
  /** Writing here replaces a link (the text is joined at run time). */
  replaces_link: boolean;
  /** Which of the sampler's prompts it feeds; null: neither. */
  reaches: "positive" | "negative" | "both" | null;
};

export type SeedGroup = {
  value: number;
  inputs: { path: SlotPath; value: number; used_by: NodeRef[] }[];
};

export type GeneratorSetup = {
  /** The slots shown: the saved ones when editing, else the proposal. */
  slots: GeneratorSlots;
  proposed: GeneratorSlots;
  found: {
    sampler: NodeRef | null;
    positive?: FoundPrompt | null;
    negative?: FoundPrompt | null;
    /** The model loader's checkpoint input, offered as a slot (never chosen for the user). */
    checkpoint?: { path: SlotPath; value: string; installed?: boolean | null };
    /** The workflow's own LoRAs; ``installed`` null before ComfyUI was reached. */
    loras?: { node: string; name: string; strength: number | null; installed?: boolean | null }[];
    lora?: {
      loader: NodeRef;
      model: { ref: OutputRef; title: string };
      clip: { ref: OutputRef; title: string } | null;
      existing: { name: string; strength: number | null }[];
      consumers: NodeRef[];
    };
  };
  text_inputs: TextInput[];
  seeds: SeedGroup[];
  outputs: { node: string; title: string; saves: boolean; prefix: string | null }[];
  input_images: { node: string; title: string; image: string | null }[];
  source: GeneratorOrigin;
  defaults: { base: string; negative: string };
  /** Tags in the default Base that the Character and Outfit blocks add. */
  offer: string[];
  base_without: string;
  /** What still stops these slots from being saved. */
  problems: string[];
};

/** Sampler settings; one left out stays as the Generator's graph has it. */
export type Sampling = Partial<{ sampler: string; scheduler: string; steps: number; cfg: number }>;

export type RequestState =
  | "pending"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "lost";

export type BatchState = "running" | "paused" | "done" | "failed" | "cancelled";

export type RequestError = {
  node: string;
  class_type: string | null;
  type: string | null;
  message: string;
};

export type Output = {
  idx: number;
  image_id: string;
  filename: string;
  in_library: boolean;
  /** Not in the library yet, shortly after its request finished. */
  arriving: boolean;
  /** Its versioned thumbnail; null until it is in the library. */
  thumb_url: string | null;
  quarantined: boolean;
  score: number | null;
  width: number | null;
  height: number | null;
};

export type GenRequest = {
  _id: number;
  idx: number;
  state: RequestState;
  seed: number;
  /** Images asked of this request; null when the batch size is unknown. */
  images: number | null;
  error: RequestError | null;
  progress: Progress;
  queued_at: number | null;
  finished_at: number | null;
  /** Seconds ComfyUI spent on it; null until it ends. */
  ran: number | null;
  /** Before it ends: the seconds it should take, from past runs (null with
   * nothing to go on), and how long ComfyUI has been running it. */
  expected?: number | null;
  elapsed?: number | null;
  outputs: Output[];
};

export type LoraPick = { name: string; strength: number };

/** A style LoRA in the composer: the pick plus its activation preset (a
 * snapshot of the words, like a prompt preset's). */
export type StyleLora = LoraPick & { preset?: { id: string; text: string } | null };

/** The Character block as queued: tag, display label, the tags sent, its LoRA file. */
/** What a character wears in a batch: a saved outfit's id (or "default"),
 * its name, and the tags sent. */
export type OutfitInput = { id: string; name: string; tags: string[] };

export type CharacterInput = {
  tag: string;
  label: string;
  tags: string[];
  lora: LoraPick | null;
  outfit?: OutfitInput | null;
};

/** An outfit tag: its attire group, and whether the tagger can see it. */
export type OutfitTag = { tag: string; group: string | null; checkable: boolean };

/** A saved outfit, or a character's computed Default (`_id` "default"). */
export type Outfit = {
  _id: string;
  name: string;
  /** The character it was made for. */
  character: string;
  shared: boolean;
  tags: OutfitTag[];
  /** Its thumbnail; null when the image is gone from the library. */
  image_id: string | null;
  thumb_url: string | null;
  /** A shared one this character's list leaves out. */
  hidden: boolean;
  batches?: number;
  /** How many characters wore it in those batches. */
  used_by?: number;
  /** Default only: the character's images it was read from. */
  images?: number;
  /** Default only: the cover was picked by the user (else computed). */
  cover_picked?: boolean;
  /** Default only: every tag for the editor, computed ones struck or kept,
   * then the user's own. */
  chips?: (OutfitTag & { dropped: boolean; added: boolean })[];
  /** Default only: renamed or its tags changed. */
  edited?: boolean;
};

/** An image that could be an outfit's cover, with the outfit's tags it lacks. */
export type CoverChoice = { image_id: string; thumb_url: string; missing: string[]; of: number };

/** An edit to a character's Default: name, struck computed tags, own tags,
 * cover (null: picked for you); `reset` clears name and tags. */
export type DefaultOutfitPatch = Partial<{
  name: string;
  dropped: string[];
  added: string[];
  image_id: string | null;
  reset: boolean;
}>;

export const DEFAULT_OUTFIT = "default";
/** A Default's name until the user renames it. */
export const DEFAULT_OUTFIT_NAME = "Default";

/** The save dialog's start: the image's attire, then the character's usual. */
export type OutfitPrefill = {
  image_id: string;
  character: string;
  tags: (OutfitTag & { source: "image" | "usual" })[];
};

export type OutfitBody = { name: string; character: string; tags: string[]; shared: boolean; image_id: string | null };

/** A character's computed recipe with the user's edits on top. */
export type Gender = "girl" | "boy" | "other";

export type Recipe = {
  tag: string;
  aliases: string[];
  count: number;
  /** Computed tags (droppable), then the ones the user added. */
  identity: { tag: string; dropped: boolean; added: boolean }[];
  /** The images identity was read from (solo ones when there are enough). */
  identity_images: number;
  /** Set by the user, else from the count tags on their images; null when
   * it can't be told and isn't set. */
  gender: Gender | null;
  /** What their images say, apart from the user's. */
  gender_read: Gender | null;
  gender_set: boolean;
  /** Attire signature tags: the default outfit (shown in phase 4). */
  outfit: string[];
  /** `file` is the installed file the stem resolves to; null when not installed. */
  lora: { stem: string; file: string | null; strength: number; images: number } | null;
  lora_edited: boolean;
  strength_edited: boolean;
  candidates: { stem: string; file: string | null; images: number; strength: number | null }[];
};

export type Preset = { _id: string; name: string; kind: "positive" | "negative"; text: string; updated_at: number };

/** A style LoRA's activation preset: the words it wants, by LoRA stem. */
export type LoraPreset = { _id: string; stem: string; name: string; text: string; strength: number | null; updated_at: number };

/** A suggested activation word, and where it was found. */
export type LoraWord = { word: string; sources: ("file" | "library")[]; prompts: number };

/** One ordered part of a prompt as queued: free text (role says which layer),
 * the character's tags, or an embedding. */
export type PromptPart = {
  kind: "text" | "character" | "embedding";
  role?: "prefix" | "prompt" | "text" | "preset" | "style";
  label?: string;
  text?: string;
  name?: string;
};

/** A recipe edit: dropped tags; lora a stem / file, "" none, null computed; strength or null. */
export type RecipePatch = Partial<{ dropped: string[]; added: string[]; lora: string | null; strength: number | null; gender: Gender | null }>;

export type BatchInputs = {
  base: string;
  extra: string[];
  negative_base: string;
  negative_extra: string[];
  checkpoint: string | null;
  sampling?: Sampling | null;
  loras: LoraPick[];
  character?: CharacterInput | null;
  /** Every character, in prompt order (`character` is the first). */
  characters?: CharacterInput[] | null;
  /** Layered composer batches: the parts sent and the composer's own state. */
  positive?: PromptPart[] | null;
  negative?: PromptPart[] | null;
  composer?: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  per_request: number | null;
  /** The size the user chose for this batch; null when it was the setting. */
  per_request_asked?: number | null;
  positive_text: string;
  negative_text: string;
  test?: boolean;
};

export type Batch = {
  _id: number;
  name: string;
  auto_name: boolean;
  generator: { _id: string; name: string | null };
  inputs: BatchInputs;
  created_at: number;
  state: BatchState;
  requests: GenRequest[];
};

export type BatchSummary = {
  _id: number;
  name: string;
  generator: string | null;
  created_at: number;
  width: number | null;
  height: number | null;
  state: BatchState;
  requests: number;
  failed: number;
  images: number;
  kept: number;
  /** Made, not in the library yet (downloading or waiting for the scan). */
  arriving: number;
  /** Versioned thumbnail URLs of its first images in the library. */
  thumbs: string[];
};

/** A node error from a rejected first request, mapped to the composer field. */
export type NodeError = {
  node: string;
  class_type: string | null;
  type: string | null;
  message: string;
  details: string;
  input: string | null;
  field: "checkpoint" | "sampling" | "lora" | "positive" | "negative" | null;
  lora_name?: string;
  added?: boolean;
};

export type QueueBody = {
  generator_id: string;
  checkpoint: string | null;
  sampling: Sampling;
  loras: LoraPick[];
  characters: CharacterInput[];
  positive: PromptPart[];
  negative: PromptPart[];
  composer: Record<string, unknown>;
  width: number | null;
  height: number | null;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  per_request: number | null;
  name: string | null;
};

/** What the run-time estimate reads of a queue body. */
export type EstimateBody = Pick<
  QueueBody,
  "generator_id" | "checkpoint" | "sampling" | "width" | "height" | "count" | "per_request"
>;

/** Thrown by {@link queueBatch} when ComfyUI rejects the first request. */
export class RejectedError extends Error {
  constructor(
    message: string,
    public nodeErrors: NodeError[],
  ) {
    super(message);
  }
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, jsonInit(method, body));
  if (r.status === 422) {
    const j = await r.clone().json().catch(() => ({}));
    if (Array.isArray(j.node_errors)) throw new RejectedError(String(j.detail ?? "Rejected"), j.node_errors);
  }
  if (!r.ok) throw await httpError(r);
  return r.json();
}

export const GEN_KEY = ["generate"] as const;
export const STATUS_KEY = [...GEN_KEY, "status"] as const;
export const MODELS_KEY = [...GEN_KEY, "models"] as const;
export const SETTINGS_KEY = [...GEN_KEY, "settings"] as const;
export const GENERATORS_KEY = [...GEN_KEY, "generators"] as const;
export const BATCHES_KEY = [...GEN_KEY, "batches"] as const;
export const batchKey = (id: number) => [...GEN_KEY, "batch", id] as const;
export const PRESETS_KEY = [...GEN_KEY, "presets"] as const;
export const LORA_PRESETS_KEY = [...GEN_KEY, "lora-presets"] as const;
export const recipeKey = (tag: string) => [...GEN_KEY, "recipe", tag] as const;
export const OUTFITS_KEY = [...GEN_KEY, "outfits"] as const;
export const outfitsKey = (character: string | null) => [...OUTFITS_KEY, "list", character ?? ""] as const;
export const defaultOutfitKey = (character: string) => [...OUTFITS_KEY, "default", character] as const;
export const generatorDiscoverKey = (sourceKey: string | null) => [...GEN_KEY, "discover", sourceKey] as const;
export const generatorSetupKey = (id: string | undefined) => [...GEN_KEY, "setup", id] as const;
export const generatorLatestKey = (id: string | undefined) => [...GEN_KEY, "latest", id] as const;

/** Refresh the queue after a batch changed: the status card, the batch list
 * and, given its id, that batch. */
export function invalidateQueue(qc: QueryClient, batchId?: number): void {
  void qc.invalidateQueries({ queryKey: STATUS_KEY });
  void qc.invalidateQueries({ queryKey: BATCHES_KEY });
  if (batchId !== undefined) void qc.invalidateQueries({ queryKey: batchKey(batchId) });
}

export const getSettings = () => api<ComfySettings>(`${BASE}/comfyui`);
export const putSettings = (patch: Partial<ComfySettings> & { output_path?: string | null }) =>
  send<ComfySettings>("/comfyui", "PUT", patch);
export const testConnection = () => send<ComfyStatus & { ok: boolean }>("/comfyui/test", "POST");
export const refreshModels = () => send<ComfyModels>("/comfyui/refresh", "POST");
export const setLoraChoice = (stem: string, name: string | null) =>
  send<{ ok: boolean }>("/comfyui/lora-choices", "PUT", { stem, name });
export const startTest = (generatorId: string, checkpoint: string | null) =>
  send<{ batch_id: number }>(`/generators/${generatorId}/test`, "POST", { checkpoint });
export const discoverGenerator = (source: GeneratorSourceIn) =>
  send<GeneratorSetup>("/generators/discover", "POST", source);
export const createGenerator = (body: {
  source: GeneratorSourceIn;
  name: string;
  slots: GeneratorSlots;
  defaults: { base: string; negative: string };
}) => send<Generator>("/generators", "POST", body);
export const putGenerator = (
  id: string,
  patch: Partial<{
    name: string;
    slots: GeneratorSlots;
    defaults: { base: string; negative: string };
    /** Move to a newer version of the workflow: its library image. */
    source: { image_id: string };
  }>,
) => send<Generator>(`/generators/${encodeURIComponent(id)}`, "PUT", patch);
export const deleteGenerator = (id: string) =>
  send<{ ok: boolean }>(`/generators/${encodeURIComponent(id)}`, "DELETE");
export const getGeneratorSetup = (id: string, signal?: AbortSignal, image?: string | null) =>
  api<GeneratorSetup>(
    `${BASE}/generators/${encodeURIComponent(id)}/setup${image ? `?image=${encodeURIComponent(image)}` : ""}`,
    { signal },
  );

export type NewerVersion = { image_id: string; workflow_sig: string; version: number; versions: number };
export const getGeneratorLatest = (id: string, signal?: AbortSignal) =>
  api<{ newer: NewerVersion | null }>(`${BASE}/generators/${encodeURIComponent(id)}/latest`, { signal });
export const putRecipe = (tag: string, patch: RecipePatch) =>
  send<Recipe>(`/recipes/${encodeURIComponent(tag)}`, "PUT", patch);
export const fetchDefaultOutfit = (character: string, signal?: AbortSignal) =>
  api<Outfit>(`${BASE}/outfits/default?character=${encodeURIComponent(character)}`, { signal });
export const fetchOutfitPrefill = (image: string, character: string, signal?: AbortSignal) =>
  api<OutfitPrefill>(
    `${BASE}/outfits/prefill?image=${encodeURIComponent(image)}&character=${encodeURIComponent(character)}`,
    { signal },
  );
export const putDefaultOutfit = (character: string, patch: DefaultOutfitPatch) =>
  send<Outfit>(`/outfits/default?character=${encodeURIComponent(character)}`, "PUT", patch);
/** Attire group and tagger check for tags added by hand. */
export const fetchOutfitTagInfo = (tags: readonly string[]) =>
  api<OutfitTag[]>(`${BASE}/outfits/tag-info?${tags.map((t) => `tags=${encodeURIComponent(t)}`).join("&")}`);
export const createOutfit = (body: OutfitBody) => send<Outfit>("/outfits", "POST", body);
export const updateOutfit = (id: string, patch: Partial<OutfitBody>) =>
  send<Outfit>(`/outfits/${encodeURIComponent(id)}`, "PUT", patch);
export const deleteOutfit = (id: string) => send<{ ok: boolean }>(`/outfits/${encodeURIComponent(id)}`, "DELETE");
export const hideOutfit = (id: string, character: string, hidden: boolean) =>
  send<{ ok: boolean }>(`/outfits/${encodeURIComponent(id)}/hidden`, "PUT", { character, hidden });
export const createPreset = (p: Pick<Preset, "name" | "kind" | "text">) => send<Preset>("/presets", "POST", p);
export const updatePreset = (id: string, p: Partial<Pick<Preset, "name" | "text">>) =>
  send<Preset>(`/presets/${encodeURIComponent(id)}`, "PUT", p);
export const deletePreset = (id: string) => send<{ ok: boolean }>(`/presets/${encodeURIComponent(id)}`, "DELETE");
export const createLoraPreset = (p: { lora: string; name: string; text: string; strength: number | null }) =>
  send<LoraPreset>("/lora-presets", "POST", p);
export const updateLoraPreset = (id: string, p: Partial<Pick<LoraPreset, "name" | "text" | "strength">>) =>
  send<LoraPreset>(`/lora-presets/${encodeURIComponent(id)}`, "PUT", p);
export const deleteLoraPreset = (id: string) =>
  send<{ ok: boolean }>(`/lora-presets/${encodeURIComponent(id)}`, "DELETE");
export const queueBatch = (body: QueueBody) => send<Batch>("/batches", "POST", body);
/** How long a batch would take if queued now, from past runs. */
export const estimateBatch = (body: EstimateBody, signal?: AbortSignal) =>
  apiJson<NewEstimate>(`${BASE}/estimate`, "POST", body, { signal });
export const renameBatch = (id: number, name: string) => send<Batch>(`/batches/${id}`, "PATCH", { name });
export const requeueBatch = (id: number) => send<Batch>(`/batches/${id}/requeue`, "POST");
/** Null when the batch never ran: it is deleted rather than kept cancelled. */
export const cancelBatch = (id: number) => send<Batch | null>(`/batches/${id}/cancel`, "POST");
export const cancelRequest = (batchId: number, requestId: number) =>
  send<Batch>(`/batches/${batchId}/requests/${requestId}/cancel`, "POST");
export const retryRequest = (batchId: number, requestId: number, single = false) =>
  send<Batch>(`/batches/${batchId}/requests/${requestId}/retry`, "POST", { single });

/** Connection, global busy and the queue card; fast while anything runs. */
export function useComfyStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: ({ signal }) => api<ComfyStatus>(`${BASE}/status`, { signal }),
    refetchInterval: (q) => (q.state.data?.active.length ? 1000 : 5000),
    staleTime: 0,
  });
}

export function useComfySettings() {
  return useQuery({ queryKey: SETTINGS_KEY, queryFn: ({ signal }) => api<ComfySettings>(`${BASE}/comfyui`, { signal }) });
}

export function useComfyModels() {
  return useQuery({
    queryKey: MODELS_KEY,
    queryFn: ({ signal }) => api<ComfyModels>(`${BASE}/comfyui/models`, { signal }),
  });
}

/** The built-in, then custom Generators; polls while a test run is going. */
export function useGenerators() {
  return useQuery({
    queryKey: GENERATORS_KEY,
    queryFn: ({ signal }) => api<Generator[]>(`${BASE}/generators`, { signal }),
    // Fast while a test runs, slower while its image waits for the scan.
    refetchInterval: (q) => {
      const states = (q.state.data ?? []).map(testState);
      return states.includes("running") ? 1000 : states.includes("waiting") ? 3000 : false;
    },
  });
}

/** What the viewer knows about an image before Remix is clicked
 * (`GET /generate/remix/{id}`). */
export type RemixInfo = {
  image_id: string;
  source: string;
  /** The image's ComfyUI workflow; null for A1111 and images without one. */
  workflow: { family: string | null; family_name: string | null; file_name: string | null; workflow_sig: string | null } | null;
  seed: number | null;
  /** A Moiré output: the batch and request it came from. */
  batch: {
    id: number;
    name: string;
    auto_name: boolean;
    generator_id: string;
    inputs: BatchInputs;
    seed: number | null;
    images: number | null;
    index: number;
  } | null;
};

/** What Remix starts the composer from (`?full=1`). */
export type RemixDoc = RemixInfo & {
  /** The prompt without the characters' names and identity tags. */
  prompt: string;
  negative: string;
  /** Characters with a recipe, page keys in prompt order. */
  characters: string[];
  /** The size the base sampler ran at (not an upscaled output's). */
  width: number | null;
  height: number | null;
  sampling: Sampling;
  /** The image's checkpoint when ComfyUI has it. */
  checkpoint: string | null;
  loras: (LoraPick & { installed: boolean })[];
};

export const remixKey = (imageId: string, full = false) => [...GEN_KEY, "remix", imageId, full] as const;

const remixUrl = (imageId: string, full: boolean) =>
  `${BASE}/remix/${encodeURIComponent(imageId)}${full ? "?full=1" : ""}`;

/** The viewer's light read: the workflow and batch, nothing heavier. */
export function useRemix(imageId: string, enabled = true) {
  return useQuery({
    queryKey: remixKey(imageId),
    queryFn: ({ signal }) => api<RemixInfo>(remixUrl(imageId, false), { signal }),
    enabled,
    staleTime: 30_000,
  });
}

/** The full read, when Remix is clicked. */
export const fetchRemix = (imageId: string) => api<RemixDoc>(remixUrl(imageId, true));

export function usePresets() {
  return useQuery({ queryKey: PRESETS_KEY, queryFn: ({ signal }) => api<Preset[]>(`${BASE}/presets`, { signal }) });
}

/** Every character the AI tagger knows by name, in the library or not. */
export function useCharacterNames() {
  return useQuery({
    queryKey: [...GEN_KEY, "character-names"],
    queryFn: ({ signal }) => api<string[]>(`${BASE}/character-names`, { signal }),
    staleTime: Infinity,
  });
}

export function useLoraPresets() {
  return useQuery({
    queryKey: LORA_PRESETS_KEY,
    queryFn: ({ signal }) => api<LoraPreset[]>(`${BASE}/lora-presets`, { signal }),
  });
}

/** Suggested words for a LoRA file. `describe` keeps the training tags that
 * describe (purple hair), which a style preset leaves out as too common. */
export function useLoraWords(name: string | null, { describe = false } = {}) {
  return useQuery({
    queryKey: [...GEN_KEY, "lora-words", name ?? "", describe],
    queryFn: ({ signal }) =>
      api<LoraWord[]>(`${BASE}/lora-words?name=${encodeURIComponent(name!)}${describe ? "&describe=1" : ""}`, { signal }),
    enabled: !!name,
    staleTime: 5 * 60_000,
  });
}

export function useRecipe(tag: string | null) {
  return useQuery({
    queryKey: recipeKey(tag ?? ""),
    queryFn: ({ signal }) => api<Recipe>(`${BASE}/recipes/${encodeURIComponent(tag!)}`, { signal }),
    enabled: !!tag,
  });
}

/** Every saved outfit, or one character's list (own and shared). */
export const fetchOutfits = (character: string | null, signal?: AbortSignal) =>
  api<Outfit[]>(`${BASE}/outfits${character ? `?character=${encodeURIComponent(character)}` : ""}`, { signal });

export const outfitsQuery = (character: string | null = null) => ({
  queryKey: outfitsKey(character),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchOutfits(character, signal),
  staleTime: 30_000,
});

export function useOutfits(character: string | null = null) {
  return useQuery(outfitsQuery(character));
}

/** Images `character` wears `outfit` in ("default": their usual clothes),
 * for picking its cover. */
export function useCoverChoices(character: string, outfit: string, tags?: readonly string[]) {
  // An outfit not saved yet ("") is matched by the tags it has so far.
  const q = tags ? tags.map((t) => `&tags=${encodeURIComponent(t)}`).join("") : `&outfit=${encodeURIComponent(outfit)}`;
  return useQuery({
    queryKey: [...OUTFITS_KEY, "covers", character, outfit, tags ?? null],
    queryFn: ({ signal }) =>
      api<CoverChoice[]>(`${BASE}/outfits/covers?character=${encodeURIComponent(character)}${q}`, { signal }),
    placeholderData: (prev) => prev,
  });
}

/** An outfit an image wears: how many of its checked tags it carries, and
 * whether the image is its thumbnail. */
export type WornOutfit = Outfit & { carried: number; of: number; thumbnail: boolean };

/** The outfits `imageId` wears, for the characters in it: covers first, then
 * the most carried. */
export function useWornOutfits(imageId: string, characters: readonly string[], tags: ReadonlySet<string>) {
  const q = characters.map((c) => `&characters=${encodeURIComponent(c)}`).join("");
  return useQuery({
    // The image's tags in the key: an edit to them asks again.
    queryKey: [...OUTFITS_KEY, "worn", imageId, characters, [...tags].sort().join(",")],
    queryFn: ({ signal }) => api<WornOutfit[]>(`${BASE}/outfits/worn?image=${encodeURIComponent(imageId)}${q}`, { signal }),
    enabled: characters.length > 0,
    staleTime: 30_000,
  });
}

/** A character's computed Default outfit. */
export const defaultOutfitQuery = (character: string) => ({
  queryKey: defaultOutfitKey(character),
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchDefaultOutfit(character, signal),
  staleTime: 5 * 60_000,
});

export function useDefaultOutfit(character: string | null) {
  return useQuery({ ...defaultOutfitQuery(character ?? ""), enabled: !!character });
}

/** Several characters' recipes, in order (undefined while one loads). */
export function useRecipes(tags: readonly string[]): (Recipe | undefined)[] {
  return useQueries({
    queries: tags.map((tag) => ({
      queryKey: recipeKey(tag),
      queryFn: ({ signal }: { signal: AbortSignal }) => api<Recipe>(`${BASE}/recipes/${encodeURIComponent(tag)}`, { signal }),
    })),
  }).map((q) => q.data);
}

export function useBatches(limit = 50) {
  return useQuery({
    queryKey: [...BATCHES_KEY, limit],
    queryFn: ({ signal }) => api<BatchSummary[]>(`${BASE}/batches?limit=${limit}`, { signal }),
    // A new limit is a new key: keep showing the last list until it loads.
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.some((b) => b.state === "running" || b.arriving > 0) ? 2000 : false),
  });
}

/** True while some output still waits for the download or library scan. */
export function waitingForScan(b: Batch): boolean {
  return b.requests.some((q) => q.outputs.some((o) => o.arriving));
}

/** One batch; polls while it runs or its images are still being scanned. */
export function useBatch(id: number) {
  return useQuery({
    queryKey: batchKey(id),
    queryFn: ({ signal }) => api<Batch>(`${BASE}/batches/${id}`, { signal }),
    refetchInterval: (q) => {
      const b = q.state.data;
      if (!b) return false;
      if (b.state === "running" || b.state === "paused") return 1000;
      return waitingForScan(b) ? 2000 : false;
    },
  });
}

