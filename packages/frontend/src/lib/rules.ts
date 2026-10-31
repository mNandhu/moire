// Extraction rules as the frontend sees them: workflow signatures, the
// ruleset per signature, its preview, and the original workflow of an image.
// The structured `gen.*` fields themselves (GenMeta) live in gen.ts.

import { useQuery } from "@tanstack/react-query";
import { api, apiJson } from "./api";
import type { GenMeta } from "./gen";
import { imageUrl } from "./media";

export type WorkflowPayload =
  | { source: "comfyui"; workflow: unknown; prompt: unknown }
  | { source: "a1111"; parameters: string }
  | { source?: string | null };

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

export const FIELD_LABEL: Record<RuleField, string> = {
  prompt: "Positive prompt",
  negative: "Negative prompt",
  seed: "Seed",
  model: "Model",
  sampler: "Sampler",
  steps: "Steps",
  cfg: "CFG",
};

/**
 * Where `gen` guessed `field` from by keyword match: its pinnable path, null
 * when the guess has no path, undefined when the field wasn't guessed.
 */
export function guessPath(gen: GenMeta | null | undefined, field: RuleField): string | null | undefined {
  return gen?.guessed?.includes(field as "prompt" | "negative")
    ? (gen.guess_paths?.[field as "prompt" | "negative"] ?? null)
    : undefined;
}

/** Graph marks for guessed prompts that have no pin yet: path → label. */
export function guessMarks(gen: GenMeta | null | undefined, fields: RuleFields): Map<string, string> {
  const m = new Map<string, string>();
  for (const field of ["prompt", "negative"] as const) {
    if ((fields[field] || []).length > 0) continue;
    const p = gen?.guessed?.includes(field) ? gen.guess_paths?.[field] : null;
    if (p) m.set(p, `Guessed ${FIELD_LABEL[field].toLowerCase()}`);
  }
  return m;
}

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

export const RULES_SIGNATURES_KEY = ["rules-signatures"] as const;

export function fetchSignatures(): Promise<SignatureRow[]> {
  return api<SignatureRow[]>("/api/v1/rules/signatures");
}

export const signaturesQuery = {
  queryKey: RULES_SIGNATURES_KEY,
  queryFn: fetchSignatures,
  staleTime: 60_000,
};

/** Every workflow signature with its counts and ruleset flag; one cache for
 * the gallery, tag and character pages and the Rules page. */
export function useSignatures({ enabled = true, staleTime = signaturesQuery.staleTime } = {}) {
  return useQuery({ ...signaturesQuery, staleTime, enabled });
}

export function fetchRuleset(sig: string): Promise<Ruleset> {
  return api<Ruleset>(`/api/v1/rules/${encodeURIComponent(sig)}`);
}

export function saveRuleset(sig: string, fields: RuleFields): Promise<Ruleset> {
  return apiJson<Ruleset>(`/api/v1/rules/${encodeURIComponent(sig)}`, "PUT", { fields });
}

export async function deleteRuleset(sig: string): Promise<void> {
  await apiJson(`/api/v1/rules/${encodeURIComponent(sig)}`, "DELETE");
}

export function previewRuleset(sampleImageId: string, fields: RuleFields): Promise<PreviewResult> {
  return apiJson<PreviewResult>(`/api/v1/rules/preview`, "POST", {
    sample_image_id: sampleImageId,
    fields,
  });
}

export function fetchWorkflow(id: string): Promise<WorkflowPayload> {
  return api<WorkflowPayload>(imageUrl(id, "workflow"));
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
