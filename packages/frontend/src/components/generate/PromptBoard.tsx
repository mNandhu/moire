import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  BOXES,
  ADDABLE,
  groupByBox,
  coversOf,
  isClearable,
  layerTerm,
  liveStrikes,
  placeTerms,
  rankOptions,
  repeatedTags,
  tagOf,
  type BoardLayer,
  type BoxKey,
  type Placed,
} from "../../lib/promptBoard";
import { appendPiece, appendTag, promptTerms, removeTerms, replaceName } from "../../lib/promptOutline";
import { useBoardOffers, useBoilerplate, useTagDescriptions, useTagPlaces } from "../../lib/queries";
import { useTagCovers } from "../../lib/tagSamples";
import type { TagSuggestion } from "../../lib/tagSuggest";
import { useLocalPref } from "../../hooks/useLocalPref";
import { descriptionKey } from "../../lib/tags";
import { useToast } from "../Toasts";
import { GroupBox } from "./board/GroupBox";

export type { BoardLayer, BoxKey } from "../../lib/promptBoard";

// Per viewer: whether the board is folded away. Until they choose, a phone
// starts folded: one box per part, stacked, is a long scroll of empty slots.
const FOLD_KEY = "moire.generate.boardFolded";
function phoneWidth(): boolean {
  return window.matchMedia?.("(max-width: 639px)").matches ?? false;
}
const NO_OPTIONS: TagSuggestion[] = [];

/**
 * Generate's Prompt as a board under its text: each tag in the part of the
 * scene it sets (from the tag groups and Danbooru's list), so a tag that
 * pulls the picture the wrong way, or a part left unsaid, shows. Each box
 * takes more tags (suggesting its own), each tag comes out with its x, and
 * an alias can be swapped for its tag. The text stays the one source:
 * every change is an edit to it.
 */
export function PromptBoard({
  prompt,
  onPrompt,
  layers,
  pool,
  glow,
}: {
  prompt: string;
  onPrompt: (v: string) => void;
  layers: readonly BoardLayer[];
  /** Library tags with their image counts. */
  pool: readonly TagSuggestion[];
  /** A box to light up once, when the app just wrote its tags (a new key
   * replays it). */
  glow?: { key: number; box: BoxKey } | null;
}) {
  const boilerplate = useBoilerplate();
  const { push } = useToast();
  const { data: descriptions } = useTagDescriptions();
  const describe = useCallback((id: string) => descriptions?.[descriptionKey(id)], [descriptions]);
  const latest = useRef(prompt);
  latest.current = prompt;
  const terms = useMemo(() => promptTerms(prompt), [prompt]);
  // The page rebuilds `layers` every render; parse them again only when
  // what they say changes.
  const layersKey = layers
    .map((l) => [l.key, l.label, l.character?.thumb_url ?? "", l.text ?? "", ...(l.tags ?? []).map((t) => `${t.tag}${t.dropped ? "-" : ""}`)].join("\u0000"))
    .join("\u0001");
  const layerTerms = useMemo(
    () => layers.map((l) => ({ layer: l, terms: l.tags ? l.tags.map(layerTerm) : promptTerms(l.text ?? "") })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layersKey],
  );
  const names = useMemo(
    () => [...terms, ...layerTerms.flatMap((l) => l.terms)].filter((t) => t.kind === "tag").map((t) => t.name),
    [terms, layerTerms],
  );
  const { data: places } = useTagPlaces(names);
  const { mine, theirs, repeats } = useMemo(() => {
    const mine = placeTerms(terms, places?.names, boilerplate);
    const theirs = layerTerms.map((l) => ({ layer: l.layer, terms: placeTerms(l.terms, places?.names, boilerplate) }));
    const repeats = repeatedTags([...mine, ...theirs.flatMap((l) => l.terms)]);
    return { mine, theirs, repeats };
  }, [terms, layerTerms, places, boilerplate]);
  const counts = useMemo(() => new Map(pool.map((t) => [t._id, t.count])), [pool]);

  const [opened, setOpened] = useState(false);
  const [phoneStart] = useState(phoneWidth);
  const [folded, setFold] = useLocalPref(FOLD_KEY, phoneStart);
  const { data: offers } = useBoardOffers({ enabled: opened, list: places?.list });
  const thumbOf = useTagCovers(opened);
  const present = useMemo(() => new Set(mine.flatMap((t) => [t.name, tagOf(t)])), [mine]);
  // Each box's suggestions: the library's most used first, then Danbooru's.
  const options = useMemo(() => rankOptions(offers, present, counts), [offers, present, counts]);

  const add = (typed: string) => {
    // What was typed, read as a prompt piece: a weight stays as written.
    const t = promptTerms(typed)[0];
    if (!t || t.kind !== "tag") return;
    if (present.has(t.name) || present.has(places?.names[t.name]?.alias_of ?? "")) return;
    onPrompt(t.weight != null ? appendPiece(prompt, typed.trim()) : appendTag(prompt, t.name));
  };
  const remove = (t: Placed) => onPrompt(removeTerms(prompt, [t]));
  // The tag already in the prompt: the alias only goes.
  const hasTag = (t: Placed) => mine.some((o) => o !== t && o.start !== t.start && tagOf(o) === t.place?.alias_of);
  const swapOf = (t: Placed) => {
    const tag = t.place?.alias_of;
    if (!tag) return undefined;
    return hasTag(t)
      ? { label: "Remove duplicate", run: () => onPrompt(removeTerms(prompt, [t])) }
      : { label: `Use ${tag.replace(/_/g, " ")}`, run: () => onPrompt(replaceName(prompt, t, tag)) };
  };

  const byBox = groupByBox(mine);
  // Clear: this box's Prompt tags come out (together, so a group whose
  // members all go goes whole) and every layer tag still on is struck for
  // this batch.
  const live = (k: BoxKey) => liveStrikes(theirs, k);
  const clearable = (k: BoxKey) => isClearable(k, byBox, theirs);
  const clear = (k: BoxKey, label: string) => {
    const text = removeTerms(prompt, byBox.get(k) ?? []);
    if (text !== prompt) onPrompt(text);
    const undos = live(k).flatMap((l) => (l.tags.length && l.layer.onStrike ? [l.layer.onStrike(l.tags)] : []));
    const before = prompt;
    push(`Cleared ${label}`, {
      action: {
        label: "Undo",
        onClick: () => {
          // Text typed since stays: only an untouched prompt is put back.
          if (text !== before && latest.current === text) onPrompt(before);
          for (const undo of undos) undo();
        },
      },
    });
  };
  const box = (k: BoxKey, label: string, tone?: string) => (
    <GroupBox
      key={k}
      label={label}
      box={k}
      terms={byBox.get(k) ?? []}
      covers={k === "unknown" || k === "library" ? [] : coversOf(theirs, k)}
      counts={counts}
      repeats={repeats}
      options={(ADDABLE.has(k) && options.get(k)) || NO_OPTIONS}
      thumbOf={thumbOf}
      onOpen={() => setOpened(true)}
      onAdd={add}
      onRemove={remove}
      swapOf={swapOf}
      onClear={clearable(k) ? () => clear(k, label) : undefined}
      tone={tone}
      describe={describe}
      glow={glow?.box === k ? glow.key : undefined}
    />
  );
  const unknown = byBox.get("unknown")?.length ?? 0;
  const library = byBox.get("library")?.length ?? 0;
  const shown = BOXES.filter((b) => b.expected || b.always || byBox.has(b.key) || theirs.some((l) => l.terms.some((t) => t.box === b.key)));
  const missing = BOXES.filter(
    (b) => b.expected && !byBox.has(b.key) && !theirs.some((l) => l.terms.some((t) => t.box === b.key && !t.dropped && !t.self)),
  );
  return (
    <div className="mt-3" aria-label="Prompt board" data-part-board>
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => setFold(!folded)}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted hover:text-neutral-100"
      >
        <ChevronDown size={14} className={cn("shrink-0 transition-transform", folded && "-rotate-90")} />
        <span className="shrink-0 whitespace-nowrap font-medium">Tags by part</span>
        {folded && (
          <span className="flex min-w-0 items-center gap-2 truncate text-faint">
            <span>
              {mine.length} {mine.length === 1 ? "tag" : "tags"}
            </span>
            {unknown > 0 && <span className="text-red-300">{unknown} not known</span>}
            {library > 0 && <span className="text-amber-300">{library} only in your library</span>}
            {missing.length > 0 && <span className="truncate text-amber-300">Missing {missing.map((b) => b.label).join(", ")}</span>}
          </span>
        )}
      </button>
      {!folded && (
        <div className="mt-1.5 space-y-2">
          {unknown > 0 && box("unknown", `Not a known tag (${unknown})`, "border-red-500/40 bg-red-500/5")}
          {library > 0 && box("library", `Only in your library (${library})`, "border-amber-500/40 bg-amber-500/5")}
          <div className="grid gap-2 sm:grid-cols-2">{shown.map((b) => box(b.key, b.label))}</div>
        </div>
      )}
    </div>
  );
}

