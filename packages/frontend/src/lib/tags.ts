/**
 * The three tag kinds as the frontend sees them. One `tags` array holds all
 * three: AI tags unprefixed (`1girl`), manual tags `manual:`-prefixed, prompt
 * tags `prompt:`-prefixed. Mirror of the backend's image_tags prefix helpers:
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

/** AI tags are the unprefixed kind: neither manual nor prompt. */
export function isAiTag(raw: string): boolean {
  return !isManual(raw) && !isPrompt(raw);
}

/**
 * WD tagger entries whose underscore is part of the face, not a word gap.
 * Mirror of the backend's services/tag_names.py KAOMOJIS.
 */
const KAOMOJIS = new Set([
  "0_0", "(o)_(o)", "+_+", "+-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<",
  "3_3", "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||",
]);

/**
 * A stored tag's name without its kind prefix, in stored spelling. Tags are
 * stored Danbooru-style with underscores (`blue_eyes`); see
 * services/tag_names.py.
 */
export function tagName(raw: string): string {
  if (isManual(raw)) return raw.slice(MANUAL_PREFIX.length);
  if (isPrompt(raw)) return raw.slice(PROMPT_PREFIX.length);
  return raw;
}

/** Display form: no kind prefix, underscores read as spaces (kaomoji kept). */
export function formatTag(raw: string): string {
  const name = tagName(raw);
  return KAOMOJIS.has(name) ? name : name.replace(/_/g, " ");
}

/** The key a tag's description is filed under: bare, underscored, lowercase. */
export function descriptionKey(raw: string): string {
  return canonicalName(tagName(raw)).toLowerCase();
}

/** Whether Danbooru likely has a wiki page for the tag: the tagger's own tags
 * come from its vocabulary, and a described tag is one of its tags. A prompt
 * word or a name you made up isn't. */
export function onDanbooru(aiImages: number, description: string | undefined): boolean {
  return aiImages > 0 || !!description;
}

/** The tag's page on Danbooru's wiki. */
export function danbooruWikiUrl(raw: string): string {
  return `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(descriptionKey(raw))}`;
}

/**
 * Text to match a typed query against a tag's display form: `blue_eyes` and
 * `blue eyes` are the same tag, so either spelling finds it.
 */
export function tagQueryText(q: string): string {
  return q.replace(/_/g, " ").toLowerCase();
}

/**
 * Tags as prompt text for pasting into ComfyUI / A1111: stored (underscore)
 * names, comma separated, each once, with `(` and `)` escaped, since bare parentheses
 * are emphasis syntax there (`hu_tao_\(genshin_impact\)`).
 */
export function toPromptText(tags: readonly string[]): string {
  // An AI tag and its prompt twin (`blue_eyes`, `prompt:blue_eyes`) are one
  // word in a prompt: first occurrence wins.
  const names = [...new Set(tags.map(tagName))];
  return names.map((n) => n.replace(/([()])/g, "\\$1")).join(", ");
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
  /** Raw `manual:`-prefixed tags (still prefixed; format for display). */
  manual: string[];
  /** Raw `prompt:`-prefixed tags. */
  prompt: string[];
};

/**
 * Split one `tags` array into its three kinds, preserving order within each.
 * AI and prompt tags may overlap (`1girl` and `prompt:1girl` coexist); they
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
  /** The image's other stored kinds of this same name (yours, prompt),
   * which are not listed again. */
  also?: ("manual" | "prompt")[];
};

/**
 * One image's tags in reading order for the image view: characters, then AI
 * tags most confident first, then the user's own, then prompt tags. Each name
 * is listed once, where it first appears in that order (an AI tag keeps its
 * confidence); the later kinds it also has go in `also`. Reading, it is one
 * word whichever kinds stored it.
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
  // Matched case-blind: a stored name keeps its case.
  const fold = (raw: string) => tagName(raw).toLowerCase();
  const mine = new Set(manual.map(fold));
  const prompted = new Set(prompt.map(fold));
  const alsoOf = (raw: string, kinds: readonly ("manual" | "prompt")[]) => {
    const also = kinds.filter((k) => (k === "manual" ? mine : prompted).has(fold(raw)));
    return also.length ? { also } : {};
  };
  const aiFlow = aiTags.map(
    (raw): FlowTag => ({
      raw,
      label: formatTag(raw),
      kind: characters.has(raw) ? "character" : "ai",
      confidence: conf.get(raw),
      ...alsoOf(raw, ["manual", "prompt"]),
    }),
  );
  // Stable sort: characters first, then by confidence; unknown confidence
  // keeps its stored position after the known ones.
  const rank = (t: FlowTag) => (t.kind === "character" ? 0 : 1);
  aiFlow.sort(
    (a, b) => rank(a) - rank(b) || (b.confidence ?? -1) - (a.confidence ?? -1),
  );
  const tagged = new Set(aiTags.map(fold));
  return [
    ...aiFlow,
    ...manual
      .filter((raw) => !tagged.has(fold(raw)))
      .map((raw): FlowTag => ({ raw, label: formatTag(raw), kind: "manual", ...alsoOf(raw, ["prompt"]) })),
    ...prompt
      .filter((raw) => !tagged.has(fold(raw)) && !mine.has(fold(raw)))
      .map((raw): FlowTag => ({ raw, label: formatTag(raw), kind: "prompt" })),
  ];
}

/** How a tag sits between the prompt and what the tagger saw. */
export type TagGroup = "matched" | "unprompted" | "missed" | "mine";

/**
 * An image's flow tags split by prompt adherence: tags the prompt asked for
 * and the tagger saw, ones it saw unasked, prompt tags it didn't see, and
 * the user's own. Only meaningful when the image has both AI and prompt
 * tags; otherwise null (one kind alone has nothing to compare). Order
 * within each group is the flow's.
 */
export function adherenceGroups(tags: readonly FlowTag[]): Record<TagGroup, FlowTag[]> | null {
  const seen = (t: FlowTag) => t.kind === "ai" || t.kind === "character";
  if (!tags.some(seen) || !tags.some((t) => t.kind === "prompt" || t.also?.includes("prompt"))) return null;
  const out: Record<TagGroup, FlowTag[]> = { matched: [], unprompted: [], missed: [], mine: [] };
  for (const t of tags) {
    if (seen(t)) out[t.also?.includes("prompt") ? "matched" : "unprompted"].push(t);
    // Your tag the prompt also names is still a prompted tag not seen.
    else out[t.kind === "prompt" || t.also?.includes("prompt") ? "missed" : "mine"].push(t);
  }
  return out;
}


/**
 * Bare manual-tag names for a bulk edit, from TagSearchInput chips: a picked
 * suggestion arrives as its stored `manual:` id, a typed one as plain text.
 * The backend adds the prefix, so strip it; trim and dedupe.
 */
export function bulkTagNames(chips: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const chip of chips) {
    const name = (isManual(chip) ? chip.slice(MANUAL_PREFIX.length) : chip).trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Mirror of the backend's canonical_name: trimmed, whitespace runs as one
 * underscore. Lora tokens (`<lora:...>`) pass through. */
export function canonicalName(name: string): string {
  const s = name.trim();
  return s.startsWith("<") ? s : s.replace(/\s+/g, "_");
}

export type RenamePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** The stored tag the source becomes. */
      target: string;
      /** The target when it already exists: this is a merge. */
      existing?: { _id: string; count: number };
    };

/**
 * What renaming stored tag `raw` to the typed `to` would do, for the dialog
 * preview. Mirrors services/tag_rename.py: the kind is kept, AI tags are
 * refused, prompt names are lowercase, and the same name in another spelling
 * is no rename at all.
 */
export function planRename(
  raw: string,
  to: string,
  known: readonly { _id: string; count: number }[],
): RenamePlan {
  if (isAiTag(raw)) return { ok: false, reason: "AI tags can't be renamed" };
  const prompt = isPrompt(raw);
  const typed = tagName(to.trim());
  const name = canonicalName(prompt ? typed.toLowerCase() : typed);
  if (!name) return { ok: false, reason: "Type a new name" };
  const target = (prompt ? PROMPT_PREFIX : MANUAL_PREFIX) + name;
  if (target === raw) return { ok: false, reason: "That's the current name" };
  const existing = known.find((t) => t._id === target);
  return existing ? { ok: true, target, existing } : { ok: true, target };
}

/** Tags a rename of `raw` can merge into: the others of its own kind. */
export function renameOptions<T extends { _id: string }>(raw: string, known: readonly T[]): T[] {
  const sameKind = isPrompt(raw) ? isPrompt : isManual;
  return known.filter((t) => t._id !== raw && sameKind(t._id));
}
