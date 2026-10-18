/**
 * The three tag kinds as the frontend sees them. One `tags` array holds all
 * three: AI tags unprefixed (`1girl`), manual tags `manual:`-prefixed, prompt
 * tags `prompt:`-prefixed. Mirror of the backend's image_tags prefix helpers —
 * see CONTEXT.md › Tag.
 *
 * The prefixes were hardcoded in five places (this module, TagSearchInput,
 * TagsPage, ImageView and OverviewPage), each re-deriving the same three
 * predicates. They live here once.
 */

export const MANUAL_PREFIX = "manual:";
export const PROMPT_PREFIX = "prompt:";
/** The merged cross-source entry the gallery search emits (backend ANY_PREFIX). */
export const ANY_PREFIX = "any:";

export function isManual(raw: string): boolean {
  return raw.startsWith(MANUAL_PREFIX);
}

export function isPrompt(raw: string): boolean {
  return raw.startsWith(PROMPT_PREFIX);
}

/** AI tags are the unprefixed kind — neither manual nor prompt. */
export function isAiTag(raw: string): boolean {
  return !isManual(raw) && !isPrompt(raw);
}

/** Strip the kind prefix from a stored tag for display. */
export function formatTag(raw: string): string {
  if (isManual(raw)) return raw.slice(MANUAL_PREFIX.length);
  if (isPrompt(raw)) return raw.slice(PROMPT_PREFIX.length);
  return raw;
}

/**
 * Display form for a tag that may also be a merged `any:` search entry. Only
 * the gallery search deals in `any:`; everywhere else uses formatTag.
 */
export function formatSearchTag(raw: string): string {
  if (raw.startsWith(ANY_PREFIX)) return raw.slice(ANY_PREFIX.length);
  return formatTag(raw);
}

export type PartitionedTags = {
  /** Unprefixed AI tags. */
  ai: string[];
  /** Raw `manual:`-prefixed tags (still prefixed — format for display). */
  manual: string[];
  /** Raw `prompt:`-prefixed tags. */
  prompt: string[];
};

/**
 * Split one `tags` array into its three kinds, preserving order within each.
 * AI and prompt tags may overlap (`1girl` and `prompt:1girl` coexist) — they
 * are distinct kinds and are never deduped against each other.
 */
export function partitionTags(tags: readonly string[] = []): PartitionedTags {
  const out: PartitionedTags = { ai: [], manual: [], prompt: [] };
  for (const t of tags) {
    if (isManual(t)) out.manual.push(t);
    else if (isPrompt(t)) out.prompt.push(t);
    else out.ai.push(t);
  }
  return out;
}

/** What the tagger stored alongside an image's AI tags: [tag, confidence]. */
export type AiTagMeta = {
  general_tags?: [string, number][];
  character_tags?: [string, number][];
};

export type TagKind = "character" | "ai" | "manual" | "prompt";

export type FlowTag = {
  /** The stored tag, as used for filtering. */
  raw: string;
  label: string;
  kind: TagKind;
  /** Tagger confidence (0-1), for AI and character tags when known. */
  confidence?: number;
};

/**
 * One image's tags in reading order for the image view: characters, then AI
 * tags most confident first, then the user's own, then prompt tags. AI and
 * prompt tags that share a name both appear: they are different kinds and
 * filter differently (see partitionTags).
 */
export function tagFlow(tags: readonly string[] = [], ai?: AiTagMeta | null): FlowTag[] {
  const conf = new Map<string, number>();
  for (const [t, p] of ai?.general_tags ?? []) conf.set(t, p);
  const characters = new Set<string>();
  for (const [t, p] of ai?.character_tags ?? []) {
    conf.set(t, p);
    characters.add(t);
  }
  const { ai: aiTags, manual, prompt } = partitionTags(tags);
  const aiFlow = aiTags.map(
    (raw): FlowTag => ({
      raw,
      label: raw,
      kind: characters.has(raw) ? "character" : "ai",
      confidence: conf.get(raw),
    }),
  );
  // Stable sort: characters first, then by confidence; unknown confidence
  // keeps its stored position after the known ones.
  const rank = (t: FlowTag) => (t.kind === "character" ? 0 : 1);
  aiFlow.sort(
    (a, b) => rank(a) - rank(b) || (b.confidence ?? -1) - (a.confidence ?? -1),
  );
  return [
    ...aiFlow,
    ...manual.map((raw): FlowTag => ({ raw, label: formatTag(raw), kind: "manual" })),
    ...prompt.map((raw): FlowTag => ({ raw, label: formatTag(raw), kind: "prompt" })),
  ];
}

