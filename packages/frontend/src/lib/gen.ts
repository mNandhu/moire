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

export type WorkflowPayload =
  | { source: "comfyui"; workflow: unknown; prompt: unknown }
  | { source: "a1111"; parameters: string }
  | { source?: string | null };

// --- Extraction rules (v2) ---------------------------------------------------

export const RULE_FIELDS = [
  "prompt",
  "negative",
  "seed",
  "model",
  "sampler",
  "steps",
  "cfg",
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleFields = Partial<Record<RuleField, string[]>>;

export type Ruleset = { _id: string; fields: RuleFields; updated_at?: number };

export type SignatureRow = {
  workflow_sig: string;
  count: number;
  needs_mapping: number;
  /** Images whose prompt was only guessed by keywords. */
  guessed?: number;
  sample_image_id: string;
  has_ruleset: boolean;
  /** Human summary (added server-side; absent from older backends). */
  sample_thumb_url?: string;
  model?: string | null;
  node_count?: number;
  /** Node types this workflow has beyond what every workflow shares. */
  distinct?: Array<{ type: string; count: number }>;
  /** ComfyUI editor-graph id: every version of one saved workflow file
   * (and its copies) shares it. Null for non-ComfyUI images. */
  workflow_id?: string | null;
  /** The user's name for the whole family, if set. */
  workflow_name?: string | null;
  /** Imported file this version matches best, and how closely (0 to 1). */
  file_name?: string | null;
  file_match?: number | null;
  /** Earliest and latest image mtime (epoch seconds): when it was in use. */
  first_used?: number | null;
  last_used?: number | null;
  /** Full node-type counts of the sample graph. */
  node_types?: Record<string, number>;
};

export type PreviewResult = {
  gen: GenMeta | null;
  paths: Partial<
    Record<RuleField, Array<{ path: string; raw: unknown; coerced: unknown }>>
  >;
};

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T;
}

export function fetchSignatures(): Promise<SignatureRow[]> {
  return getJson<SignatureRow[]>("/api/v1/rules/signatures");
}

export function fetchRuleset(sig: string): Promise<Ruleset> {
  return getJson<Ruleset>(`/api/v1/rules/${encodeURIComponent(sig)}`);
}

export async function saveRuleset(
  sig: string,
  fields: RuleFields,
): Promise<Ruleset> {
  const r = await fetch(`/api/v1/rules/${encodeURIComponent(sig)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as Ruleset;
}

export async function deleteRuleset(sig: string): Promise<void> {
  const r = await fetch(`/api/v1/rules/${encodeURIComponent(sig)}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error(await r.text());
}

export async function previewRuleset(
  sampleImageId: string,
  fields: RuleFields,
): Promise<PreviewResult> {
  const r = await fetch(`/api/v1/rules/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sample_image_id: sampleImageId, fields }),
  });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as PreviewResult;
}

export async function fetchWorkflow(id: string): Promise<WorkflowPayload> {
  const r = await fetch(`/api/v1/images/${encodeURIComponent(id)}/workflow`);
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as WorkflowPayload;
}

/** The clipboard string for copy-workflow / remix, format-aware:
 *  ComfyUI → the UI `workflow` graph JSON (drops onto the canvas);
 *  A1111   → the `parameters` string (pastes into the prompt box). */
export function workflowClipboardText(p: WorkflowPayload): string | null {
  if (!p || !p.source) return null;
  if (p.source === "comfyui") {
    const wf = (p as { workflow?: unknown }).workflow;
    const pr = (p as { prompt?: unknown }).prompt;
    const payload = wf ?? pr;
    return payload != null ? JSON.stringify(payload) : null;
  }
  if (p.source === "a1111") {
    return (p as { parameters?: string }).parameters ?? null;
  }
  return null;
}
