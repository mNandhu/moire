/**
 * Generation (ComfyUI) API: types, fetchers and the polled queries. The
 * browser never talks to ComfyUI; everything goes through `/api/v1/generate`.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

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
};

export type ComfyStatus = {
  configured: boolean;
  connected: boolean;
  error: string | null;
  busy: boolean;
  queue_remaining: number;
  active: ActiveBatch[];
};

export type LoraMatch = { stem: string; images: number; files: string[]; name: string | null };

export type ComfyModels = {
  checkpoints: string[];
  loras: string[];
  embeddings: string[];
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
  slots: Record<string, unknown>;
  test: GeneratorTest | null;
};

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
  outputs: Output[];
};

export type LoraPick = { name: string; strength: number };

/** The Character block as queued: tag, display label, the tags sent, its LoRA file. */
export type CharacterInput = { tag: string; label: string; tags: string[]; lora: LoraPick | null };

/** A character's computed recipe with the user's edits on top. */
export type Recipe = {
  tag: string;
  aliases: string[];
  count: number;
  /** Computed tags (droppable), then the ones the user added. */
  identity: { tag: string; dropped: boolean; added: boolean }[];
  /** Attire signature tags: the default outfit (shown in phase 4). */
  outfit: string[];
  /** `file` is the installed file the stem resolves to; null when not installed. */
  lora: { stem: string; file: string | null; strength: number; images: number } | null;
  lora_edited: boolean;
  strength_edited: boolean;
  candidates: { stem: string; file: string | null; images: number; strength: number | null }[];
};

export type Preset = { _id: string; name: string; kind: "positive" | "negative"; text: string; updated_at: number };

/** One ordered part of a prompt as queued: free text (role says which layer),
 * the character's tags, or an embedding. */
export type PromptPart = {
  kind: "text" | "character" | "embedding";
  role?: "prefix" | "prompt" | "text" | "preset";
  label?: string;
  text?: string;
  name?: string;
};

/** A recipe edit: dropped tags; lora a stem / file, "" none, null computed; strength or null. */
export type RecipePatch = Partial<{ dropped: string[]; added: string[]; lora: string | null; strength: number | null }>;

export type BatchInputs = {
  base: string;
  extra: string[];
  negative_base: string;
  negative_extra: string[];
  checkpoint: string | null;
  loras: LoraPick[];
  character?: CharacterInput | null;
  /** Layered composer batches: the parts sent and the composer's own state. */
  positive?: PromptPart[] | null;
  negative?: PromptPart[] | null;
  composer?: Record<string, unknown> | null;
  width: number | null;
  height: number | null;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  per_request: number | null;
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
  field: "checkpoint" | "lora" | "positive" | "negative" | null;
  lora_name?: string;
  added?: boolean;
};

export type QueueBody = {
  generator_id: string;
  checkpoint: string | null;
  loras: LoraPick[];
  character: CharacterInput | null;
  positive: PromptPart[];
  negative: PromptPart[];
  composer: Record<string, unknown>;
  width: number | null;
  height: number | null;
  seed: { mode: "random" | "fixed"; value: number | null };
  count: number;
  name: string | null;
};

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
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 422) {
    const j = await r.json().catch(() => ({}));
    if (Array.isArray(j.node_errors)) throw new RejectedError(String(j.detail ?? "Rejected"), j.node_errors);
  }
  if (!r.ok) {
    const text = await r.text();
    let detail = text;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      /* plain text */
    }
    throw new Error(typeof detail === "string" ? detail : text);
  }
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
export const recipeKey = (tag: string) => [...GEN_KEY, "recipe", tag] as const;

export const getSettings = () => api<ComfySettings>(`${BASE}/comfyui`);
export const putSettings = (patch: Partial<ComfySettings> & { output_path?: string | null }) =>
  send<ComfySettings>("/comfyui", "PUT", patch);
export const testConnection = () => send<ComfyStatus & { ok: boolean }>("/comfyui/test", "POST");
export const refreshModels = () => send<ComfyModels>("/comfyui/refresh", "POST");
export const setLoraChoice = (stem: string, name: string | null) =>
  send<{ ok: boolean }>("/comfyui/lora-choices", "PUT", { stem, name });
export const startTest = (generatorId: string, checkpoint: string | null) =>
  send<{ batch_id: number }>(`/generators/${generatorId}/test`, "POST", { checkpoint });
export const putRecipe = (tag: string, patch: RecipePatch) =>
  send<Recipe>(`/recipes/${encodeURIComponent(tag)}`, "PUT", patch);
export const createPreset = (p: Pick<Preset, "name" | "kind" | "text">) => send<Preset>("/presets", "POST", p);
export const updatePreset = (id: string, p: Partial<Pick<Preset, "name" | "text">>) =>
  send<Preset>(`/presets/${encodeURIComponent(id)}`, "PUT", p);
export const deletePreset = (id: string) => send<{ ok: boolean }>(`/presets/${encodeURIComponent(id)}`, "DELETE");
export const queueBatch = (body: QueueBody) => send<Batch>("/batches", "POST", body);
export const renameBatch = (id: number, name: string) => send<Batch>(`/batches/${id}`, "PATCH", { name });
export const requeueBatch = (id: number) => send<Batch>(`/batches/${id}/requeue`, "POST");
export const cancelBatch = (id: number) => send<Batch>(`/batches/${id}/cancel`, "POST");
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

/** The Generators (phase 1: the built-in); polls while a test run is going. */
export function useGenerators() {
  return useQuery({
    queryKey: GENERATORS_KEY,
    queryFn: ({ signal }) => api<Generator[]>(`${BASE}/generators`, { signal }),
    refetchInterval: (q) =>
      q.state.data?.some((g) => !g.ready && g.test && !["failed", "lost", "cancelled"].includes(g.test.state))
        ? 1000
        : false,
  });
}

export function usePresets() {
  return useQuery({ queryKey: PRESETS_KEY, queryFn: ({ signal }) => api<Preset[]>(`${BASE}/presets`, { signal }) });
}

export function useRecipe(tag: string | null) {
  return useQuery({
    queryKey: recipeKey(tag ?? ""),
    queryFn: ({ signal }) => api<Recipe>(`${BASE}/recipes/${encodeURIComponent(tag!)}`, { signal }),
    enabled: !!tag,
  });
}

export function useBatches(limit = 50) {
  return useQuery({
    queryKey: [...BATCHES_KEY, limit],
    queryFn: ({ signal }) => api<BatchSummary[]>(`${BASE}/batches?limit=${limit}`, { signal }),
    refetchInterval: (q) => (q.state.data?.some((b) => b.state === "running") ? 2000 : false),
  });
}

/** True while some output still waits for the library scan. */
export function waitingForScan(b: Batch): boolean {
  return b.requests.some((q) => q.state === "done" && q.outputs.some((o) => !o.in_library));
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

export const thumbUrl = (imageId: string) => `/api/v1/images/${encodeURIComponent(imageId)}/thumb`;
