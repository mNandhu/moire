import { fuzzyRank, fuzzyScore } from "@/lib/fuzzy";
import { splitBoilerplate } from "./boilerplate";
import { ANY_PREFIX, formatSearchTag, tagName, tagQueryText } from "./tags";
import { resourceOf } from "./searchTerms";

export type TagSuggestion = {
  _id: string;
  count: number;
  /** The Danbooru alias the typed text matched, when the tag's own name
   * doesn't: the row shows it led here. */
  via?: string;
};

/** A tag's Danbooru aliases in display form (`anime_screenshot` ->
 * `anime screencap`), by its bare name. */
export type AliasesOf = (tag: string) => readonly string[] | undefined;

const bareName = (id: string) => tagName(id.startsWith(ANY_PREFIX) ? id.slice(ANY_PREFIX.length) : id);

const MAX_SUGGESTIONS = 8;
// Rows kept for loras and embeddings when tags also match: they rank below
// tags, but a long tag list mustn't hide them.
const RESOURCE_ROWS = 2;
const TYPED_KIND = /^(lora|embedding|emb|outfit):\s*(.*)$/i;

/**
 * The suggestions for typed text: tags fuzzy-ranked on their display form
 * (so `blue_eyes` and `blue eyes` find the same tag), boilerplate after
 * every other match ("best" offers "best friend" before "best quality"),
 * then loras and embeddings (`resources`, ids `lora:name` /
 * `embedding:name`) matched on their name, below the tags but always given
 * a row or two. Typing `lora:` (or `embedding:`, `emb:`) lists only that
 * kind. A tag also matches on its Danbooru aliases (`aliasesOf`), so typing
 * `anime screencap` offers `anime screenshot`. Pure.
 */
export function rankSuggestions(
  text: string,
  pool: readonly TagSuggestion[],
  resources: readonly TagSuggestion[],
  isBoilerplate: (tag: string) => boolean,
  aliasesOf?: AliasesOf,
): TagSuggestion[] {
  const q = text.trim();
  if (!q) return [];
  const nameOf = (s: TagSuggestion) => s._id.slice(s._id.indexOf(":") + 1);
  const typed = TYPED_KIND.exec(q);
  if (typed) {
    const k = typed[1].toLowerCase();
    const kind = k === "lora" ? "lora:" : k === "outfit" ? "outfit:" : "embedding:";
    const ofKind = resources.filter((r) => r._id.startsWith(kind));
    const rest = typed[2].trim();
    return rest
      ? fuzzyRank(rest, ofKind, nameOf, MAX_SUGGESTIONS)
      : [...ofKind].sort((a, b) => b.count - a.count).slice(0, MAX_SUGGESTIONS);
  }
  const textOf = (s: TagSuggestion) => {
    const shown = formatSearchTag(s._id);
    const aliases = aliasesOf?.(bareName(s._id));
    return aliases?.length ? [shown, ...aliases] : shown;
  };
  const query = tagQueryText(q);
  const ranked = fuzzyRank(query, [...pool], textOf, pool.length);
  const { kept, boilerplate } = splitBoilerplate(ranked, (s) => s._id, isBoilerplate);
  const tags = [...kept, ...boilerplate];
  const res = fuzzyRank(q, resources, nameOf, MAX_SUGGESTIONS);
  // Only the rows shown say which alias led to them.
  const head = tags.slice(0, MAX_SUGGESTIONS - Math.min(RESOURCE_ROWS, res.length)).map((s) => withVia(s, query, aliasesOf));
  return [...head, ...res.slice(0, MAX_SUGGESTIONS - head.length)];
}

/** `s` marked with the alias that matched `query`, when its own name doesn't. */
function withVia(s: TagSuggestion, query: string, aliasesOf: AliasesOf | undefined): TagSuggestion {
  const aliases = aliasesOf?.(bareName(s._id));
  if (!aliases?.length || fuzzyScore(query, formatSearchTag(s._id)) !== null) return s;
  let via: string | undefined;
  let best = -Infinity;
  for (const a of aliases) {
    const score = fuzzyScore(query, a);
    if (score !== null && score > best) {
      best = score;
      via = a;
    }
  }
  return via ? { ...s, via } : s;
}

/** A lora or embedding search term's kind and name, or null for a tag. */
export function resourceLabel(id: string): { kind: string; name: string } | null {
  const r = resourceOf(id);
  return r ? { kind: r.kind === "lora" ? "LoRA" : r.kind === "outfit" ? "Outfit" : "Embedding", name: r.name } : null;
}

export type SuggestKeyAction = "down" | "up" | "accept" | "close" | "none";

/**
 * What a key does to a suggestion list. `enter` says whether Enter takes the
 * highlighted row always, or only once the user has arrowed to it (`moved`),
 * so free text can still be committed as typed; `tab` whether Tab takes it.
 * A closed list takes no key. Ctrl/Cmd+Arrow is never the list's (the prompt
 * field keeps it for tag weights), nor Ctrl/Cmd+Enter (Generate's queue key), and nothing happens mid IME composition.
 * Pure.
 */
export function suggestKeyAction(
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean },
  s: { open: boolean; moved: boolean; enter: "highlight" | "moved"; tab: boolean },
): SuggestKeyAction {
  if (!s.open || e.isComposing) return "none";
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      if (e.ctrlKey || e.metaKey) return "none";
      return e.key === "ArrowDown" ? "down" : "up";
    case "Tab":
      return s.tab ? "accept" : "none";
    case "Enter":
      // Ctrl/Cmd+Enter is the page's (Generate queues on it).
      if (e.ctrlKey || e.metaKey) return "none";
      return s.enter === "highlight" || s.moved ? "accept" : "none";
    case "Escape":
      return "close";
    default:
      return "none";
  }
}
