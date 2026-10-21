import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Undo2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { fuzzyRank } from "../../lib/fuzzy";
import { api } from "../../lib/api";
import { smallThumb } from "../../lib/media";
import type { CharacterEntry } from "../../lib/character";
import type { Sample } from "../TagMosaic";
import { appendPiece, appendTag, promptTerms, removeSpan, replaceName, type PromptTerm } from "../../lib/promptOutline";
import {
  TAGS_KEY,
  useBoardOffers,
  useBoilerplate,
  useTagBrowse,
  useTagPlaces,
  type BoardSection,
  type TagPlace,
} from "../../lib/queries";
import { CharacterAvatar } from "../CharacterAvatar";
import { TagSuggestList, type TagSuggestion } from "../TagSuggestList";
import { Tooltip } from "../ui";

/** A board box: a server section, or one the prompt's own syntax decides. */
type BoxKey = BoardSection | "prose" | "resources";

const BOXES: { key: BoxKey; label: string; expected?: boolean }[] = [
  { key: "subject", label: "Subject", expected: true },
  { key: "hair", label: "Hair", expected: true },
  { key: "eyes", label: "Eyes & gaze", expected: true },
  { key: "expression", label: "Expression", expected: true },
  { key: "body", label: "Body" },
  { key: "attire", label: "Attire", expected: true },
  { key: "pose", label: "Pose & action", expected: true },
  { key: "framing", label: "Framing", expected: true },
  { key: "background", label: "Background", expected: true },
  { key: "lighting", label: "Lighting", expected: true },
  { key: "style", label: "Style" },
  { key: "other", label: "Other" },
  { key: "quality", label: "Quality" },
  { key: "resources", label: "LoRAs & embeddings" },
  { key: "prose", label: "Prose" },
];
// Boxes a tag can be typed into.
const ADDABLE = new Set<BoxKey>(["subject", "hair", "eyes", "expression", "body", "attire", "pose", "framing", "background", "lighting", "style", "other"]);

const TONE: Record<BoxKey, string> = {
  subject: "border-sky-500/50 bg-sky-500/10 text-sky-100",
  hair: "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-100",
  eyes: "border-cyan-500/50 bg-cyan-500/10 text-cyan-100",
  expression: "border-pink-500/50 bg-pink-500/10 text-pink-100",
  body: "border-rose-500/50 bg-rose-500/10 text-rose-100",
  attire: "border-violet-500/50 bg-violet-500/10 text-violet-100",
  pose: "border-emerald-500/50 bg-emerald-500/10 text-emerald-100",
  framing: "border-teal-500/50 bg-teal-500/10 text-teal-100",
  background: "border-lime-500/50 bg-lime-500/10 text-lime-100",
  lighting: "border-amber-500/50 bg-amber-500/10 text-amber-100",
  style: "border-orange-500/50 bg-orange-500/10 text-orange-100",
  other: "border-line-strong bg-raised text-neutral-200",
  quality: "border-line bg-raised text-faint",
  unknown: "border-dashed border-red-500/60 bg-red-500/10 text-red-100",
  resources: "border-brand-500/50 bg-brand-500/10 text-brand-100",
  prose: "border-line bg-transparent text-muted italic",
};

/** One of a layer's tags. `onToggle` strikes it out (or brings it back)
 * where the layer keeps it: a recipe's identity, an outfit pick. */
export type LayerTag = { tag: string; dropped?: boolean; onToggle?: () => void; self?: boolean };

/** A layer other than the Prompt: a character (their recipe's tags, shown
 * in each box beside their avatar) or a text layer (prefix, preset). What
 * it covers keeps a part from reading as missing. */
export type BoardLayer = { key: string; label: string; character?: CharacterEntry; text?: string; tags?: LayerTag[] };

type Placed = PromptTerm & { box: BoxKey; place?: TagPlace; dropped?: boolean; self?: boolean; onToggle?: () => void };
type Cover = { layer: BoardLayer; terms: Placed[] };

/** A layer tag as a term (it has no place in the Prompt's text). */
function layerTerm(t: LayerTag): PromptTerm & Pick<Placed, "dropped" | "self" | "onToggle"> {
  return { name: t.tag.toLowerCase(), written: t.tag.replace(/_/g, " "), kind: "tag", start: -1, end: -1, nameStart: -1, nameEnd: -1, dropped: t.dropped, self: t.self, onToggle: t.onToggle };
}

const LIST_ROWS = 40;
// Per viewer: whether the board is folded away.
const FOLD_KEY = "moire.generate.boardFolded";
function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
}
const NO_OPTIONS: TagSuggestion[] = [];
const tagOf = (t: Placed) => t.place?.alias_of ?? t.name;
const pretty = (g?: string) => (g ? g.replace(/_tags$/, "").replace(/_/g, " ") : "");
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function boxOf(t: PromptTerm, place: TagPlace | undefined, boilerplate: (n: string) => boolean): BoxKey {
  if (t.kind === "lora" || t.kind === "embedding") return "resources";
  if (t.kind === "prose") return "prose";
  if (boilerplate(t.name) || boilerplate(place?.alias_of ?? "")) return "quality";
  return place?.section ?? "other";
}

/** Hover card: a few library images with the tag, how common it is, where
 * it's filed, and the tag an alias stands for. */
function TagPreview({ term, count, swap }: { term: Placed; count: number | undefined; swap?: { label: string; run: () => void } }) {
  const p = term.place;
  const tag = p?.alias_of ?? term.name;
  const tagged = term.kind === "tag";
  const { data, isPending } = useQuery({
    // The Tags page's pick: shuffled, one image per batch while it can.
    queryKey: [...TAGS_KEY, "samples", `any:${tag}`, 4],
    queryFn: ({ signal }) =>
      api<Record<string, Sample[]>>(`/api/v1/tags/samples?${new URLSearchParams({ tags: `any:${tag}`, per: "4" })}`, { signal }).then(
        (r) => r[`any:${tag}`] ?? [],
      ),
    enabled: tagged,
    staleTime: 60_000,
  });
  return (
    <div className="w-[17rem] space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="font-medium text-neutral-50">{term.written}</span>
        {term.weight != null && <span className="text-xs text-amber-300">{term.weight}</span>}
        {tagged && (
          <span className="ml-auto text-xs text-faint">
            {count ? `${count.toLocaleString()} ${count === 1 ? "image" : "images"}` : "Not in library"}
          </span>
        )}
      </div>
      {p?.alias_of && (
        <div className="flex items-center gap-2 text-xs text-amber-200">
          Alias of {p.alias_of.replace(/_/g, " ")}
          {swap && (
            <button type="button" onClick={swap.run} className="ml-auto rounded-md bg-amber-500/15 px-2 py-0.5 text-amber-100 hover:bg-amber-500/25">
              {swap.label}
            </button>
          )}
        </div>
      )}
      {tagged && (
        <div className="grid h-[92px] grid-cols-4 gap-1">
          {isPending
            ? Array.from({ length: 4 }, (_, i) => <div key={i} className="animate-pulse rounded bg-surface" />)
            : (data ?? []).map((img) => <img key={img._id} src={smallThumb(img.thumb_url)} alt="" className="h-full w-full rounded object-cover" />)}
          {!isPending && !data?.length && (
            <div className="col-span-4 grid place-items-center rounded border border-dashed border-line text-xs text-faint">No images with it yet</div>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-faint">
        {term.box === "unknown" ? (
          <span className="text-red-300">Not a Danbooru tag</span>
        ) : (
          <>
            {p?.group && <span>{pretty(p.group)}</span>}
            {p?.posts != null && <span>{compact(p.posts)} on Danbooru</span>}
          </>
        )}
      </div>
    </div>
  );
}

function Chip({
  term,
  counts,
  repeated,
  onRemove,
  swap,
}: {
  term: Placed;
  counts: Map<string, number>;
  repeated?: boolean;
  onRemove?: () => void;
  swap?: { label: string; run: () => void };
}) {
  const label = term.kind === "lora" ? term.name.replace(/^<lora:|>$/g, "").split(":")[0] : term.written;
  const alias = !!term.place?.alias_of;
  return (
    <Tooltip content={<TagPreview term={term} count={counts.get(term.place?.alias_of ?? term.name)} swap={swap} />}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex cursor-default items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs outline-none",
          term.dropped ? "border-line/60 text-faint line-through" : TONE[term.box],
          alias && "border-dashed border-amber-400/70",
          repeated && "ring-1 ring-amber-400/70",
        )}
      >
        {label}
        {term.weight != null && <span className="text-[10px] opacity-70">{term.weight}</span>}
        {onRemove && (
          <button
            type="button"
            aria-label={`${term.dropped ? "Bring back" : "Remove"} ${label}`}
            onClick={onRemove}
            className="-mr-0.5 rounded no-underline opacity-50 hover:bg-white/10 hover:opacity-100"
          >
            {term.dropped ? <Undo2 size={12} /> : <X size={12} />}
          </button>
        )}
      </span>
    </Tooltip>
  );
}

/** A layer's tags in a box, on their own line: a character's avatar and
 * name, else the layer's name. */
function CoverRow({ cover, counts }: { cover: Cover; counts: Map<string, number> }) {
  const c = cover.layer.character;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 pr-0.5 text-xs text-muted">
        {c && <CharacterAvatar src={c.thumb_url} face={c.face} focus={c.focus} aspect={c.aspect} letter={cover.layer.label} className="h-5 w-5 ring-1 ring-line" />}
        {cover.layer.label}
      </span>
      {cover.terms
        .filter((t) => !t.self)
        .map((t) => (
          <Chip key={t.name} term={t} counts={counts} onRemove={t.onToggle} />
        ))}
    </div>
  );
}

function GroupBox({
  label,
  box,
  terms,
  covers,
  counts,
  repeats,
  options,
  thumbOf,
  onOpen,
  onAdd,
  onRemove,
  swapOf,
  tone,
}: {
  label: string;
  box: BoxKey;
  terms: readonly Placed[];
  covers: Cover[];
  counts: Map<string, number>;
  repeats: Set<string>;
  options: readonly TagSuggestion[];
  thumbOf: (id: string) => string | null;
  onOpen: () => void;
  onAdd: (name: string) => void;
  onRemove: (t: Placed) => void;
  swapOf: (t: Placed) => { label: string; run: () => void } | undefined;
  tone?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  // Nothing is highlighted until the arrows move into the list, so Enter
  // adds what was typed.
  const [active, setActive] = useState(-1);
  const addable = ADDABLE.has(box);
  const matches = useMemo(() => {
    if (!open) return [];
    const query = q.trim().replace(/_/g, " ");
    return query ? fuzzyRank(query, options, (o) => o._id.replace(/_/g, " "), LIST_ROWS) : options.slice(0, LIST_ROWS);
  }, [open, q, options]);
  const add = (name: string) => {
    if (!name.trim()) return;
    onAdd(name);
    setQ("");
    setActive(-1);
  };
  const gap = terms.length === 0 && !covers.some((c) => c.terms.some((t) => !t.dropped));
  const missing = gap && BOXES.find((b) => b.key === box)?.expected;
  return (
    <div
      className={cn(
        "relative rounded-lg border px-3 py-2 transition-colors",
        addable && "cursor-text hover:border-line-strong",
        open ? "border-brand-600/70 bg-canvas/80" : (tone ?? (missing ? "border-dashed border-amber-500/40 bg-amber-500/5" : "border-line bg-canvas/60")),
      )}
      onMouseDown={(e) => {
        if (!addable || (e.target as HTMLElement).closest("button, input, [tabindex]")) return;
        e.preventDefault();
        input.current?.focus();
      }}
    >
      <div className="mb-1.5 flex min-h-5 items-center gap-1.5 text-xs font-medium text-muted">
        {label}
        {missing && <span className="text-amber-300">Missing</span>}
      </div>
      {covers.length > 0 && (
        <div className="mb-1.5 space-y-1.5">
          {covers.map((c) => (
            <CoverRow key={c.layer.key} cover={c} counts={counts} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {terms.map((t) => (
          <Chip
            key={`${t.name}@${t.start}`}
            term={t}
            counts={counts}
            repeated={repeats.has(t.place?.alias_of ?? t.name)}
            onRemove={() => onRemove(t)}
            swap={swapOf(t)}
          />
        ))}
        {addable && (
          <input
            ref={input}
            value={q}
            aria-label={`Add to ${label}`}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(-1);
            }}
            onFocus={() => {
              setOpen(true);
              onOpen();
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setActive((a) => Math.max(0, Math.min(matches.length - 1, a + d)));
              } else if (e.key === "Tab" && matches.length && (q.trim() || active >= 0)) {
                e.preventDefault();
                add(matches[Math.max(0, active)]._id);
              } else if (e.key === "Enter") {
                e.preventDefault();
                add(active >= 0 && matches[active] ? matches[active]._id : q);
              } else if (e.key === ",") {
                e.preventDefault();
                add(q);
              } else if (e.key === "Escape") {
                setQ("");
                input.current?.blur();
              } else if (e.key === "Backspace" && !q && terms.length) {
                onRemove(terms[terms.length - 1]);
              }
            }}
            className="h-6 min-w-[5rem] flex-1 border-0 bg-transparent p-0 text-xs text-neutral-100 outline-none focus-visible:shadow-none"
          />
        )}
      </div>
      {open && matches.length > 0 && (
        <TagSuggestList matches={matches} active={active} onActive={setActive} onPick={(m) => add(m._id)} thumbOf={thumbOf} className="left-0 top-full z-30" />
      )}
    </div>
  );
}

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
}: {
  prompt: string;
  onPrompt: (v: string) => void;
  layers: readonly BoardLayer[];
  /** Library tags with their image counts. */
  pool: readonly TagSuggestion[];
}) {
  const boilerplate = useBoilerplate();
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
    const placed = (t: PromptTerm & Partial<Placed>): Placed => {
      const place = places?.names[t.name];
      return { ...t, place, box: boxOf(t, place, boilerplate) };
    };
    const mine = terms.map(placed);
    const theirs = layerTerms.map((l) => ({ layer: l.layer, terms: l.terms.map(placed) }));
    const seen = new Map<string, number>();
    for (const t of [...mine, ...theirs.flatMap((l) => l.terms)]) if (!t.dropped) seen.set(tagOf(t), (seen.get(tagOf(t)) ?? 0) + 1);
    const repeats = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
    return { mine, theirs, repeats };
  }, [terms, layerTerms, places, boilerplate]);
  const counts = useMemo(() => new Map(pool.map((t) => [t._id, t.count])), [pool]);

  const [opened, setOpened] = useState(false);
  const [folded, setFolded] = useState(readFolded);
  const setFold = (v: boolean) => {
    setFolded(v);
    try {
      localStorage.setItem(FOLD_KEY, v ? "1" : "0");
    } catch {
      // Storage off: it just won't be remembered.
    }
  };
  const { data: offers } = useBoardOffers({ enabled: opened, list: places?.list });
  const { data: browse } = useTagBrowse("all", { enabled: opened });
  const thumbs = useMemo(() => new Map((browse ?? []).map((b) => [b.tag, b.thumb_url])), [browse]);
  const thumbOf = useCallback((id: string) => thumbs.get(id) ?? null, [thumbs]);
  const present = useMemo(() => new Set(mine.flatMap((t) => [t.name, tagOf(t)])), [mine]);
  // Each box's suggestions: the library's most used first, then Danbooru's.
  const options = useMemo(() => {
    const out = new Map<BoxKey, TagSuggestion[]>();
    for (const [k, list] of Object.entries(offers ?? {}) as [BoardSection, [string, number][]][]) {
      out.set(
        k,
        list
          .filter(([n]) => !present.has(n))
          .map(([n, posts]) => ({ _id: n, count: counts.get(n) ?? 0, posts }))
          .sort((a, b) => b.count - a.count || b.posts - a.posts)
          .map(({ _id, count }) => ({ _id, count })),
      );
    }
    return out;
  }, [offers, present, counts]);

  const add = (typed: string) => {
    // What was typed, read as a prompt piece: a weight stays as written.
    const t = promptTerms(typed)[0];
    if (!t || t.kind !== "tag") return;
    if (present.has(t.name) || present.has(places?.names[t.name]?.alias_of ?? "")) return;
    onPrompt(t.weight != null ? appendPiece(prompt, typed.trim()) : appendTag(prompt, t.name));
  };
  const remove = (t: Placed) => onPrompt(removeSpan(prompt, t.start, t.end));
  // The tag already in the prompt: the alias only goes.
  const hasTag = (t: Placed) => mine.some((o) => o !== t && o.start !== t.start && tagOf(o) === t.place?.alias_of);
  const swapOf = (t: Placed) => {
    const tag = t.place?.alias_of;
    if (!tag) return undefined;
    return hasTag(t)
      ? { label: "Remove duplicate", run: () => onPrompt(removeSpan(prompt, t.start, t.end)) }
      : { label: `Use ${tag.replace(/_/g, " ")}`, run: () => onPrompt(replaceName(prompt, t, tag)) };
  };

  const byBox = new Map<BoxKey, Placed[]>();
  for (const t of mine) byBox.set(t.box, [...(byBox.get(t.box) ?? []), t]);
  const coversOf = (k: BoxKey) => theirs.flatMap((l) => {
    const ts = l.terms.filter((t) => t.box === k);
    return ts.length ? [{ layer: l.layer, terms: ts }] : [];
  });
  const box = (k: BoxKey, label: string, tone?: string) => (
    <GroupBox
      key={k}
      label={label}
      box={k}
      terms={byBox.get(k) ?? []}
      covers={k === "unknown" ? [] : coversOf(k)}
      counts={counts}
      repeats={repeats}
      options={(ADDABLE.has(k) && options.get(k)) || NO_OPTIONS}
      thumbOf={thumbOf}
      onOpen={() => setOpened(true)}
      onAdd={add}
      onRemove={remove}
      swapOf={swapOf}
      tone={tone}
    />
  );
  const unknown = byBox.get("unknown")?.length ?? 0;
  const shown = BOXES.filter((b) => b.expected || byBox.has(b.key) || theirs.some((l) => l.terms.some((t) => t.box === b.key)));
  const missing = BOXES.filter(
    (b) => b.expected && !byBox.has(b.key) && !theirs.some((l) => l.terms.some((t) => t.box === b.key && !t.dropped)),
  );
  return (
    <div className="mt-3" aria-label="Prompt board">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => setFold(!folded)}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs text-muted hover:text-neutral-100"
      >
        <ChevronDown size={14} className={cn("transition-transform", folded && "-rotate-90")} />
        <span className="font-medium">Tags by part</span>
        {folded && (
          <span className="flex min-w-0 items-center gap-2 truncate text-faint">
            <span>
              {mine.length} {mine.length === 1 ? "tag" : "tags"}
            </span>
            {unknown > 0 && <span className="text-red-300">{unknown} not known</span>}
            {missing.length > 0 && <span className="truncate text-amber-300">Missing {missing.map((b) => b.label).join(", ")}</span>}
          </span>
        )}
      </button>
      {!folded && (
        <div className="mt-1.5 space-y-2">
          {unknown > 0 && box("unknown", `Not a known tag (${unknown})`, "border-red-500/40 bg-red-500/5")}
          <div className="grid gap-2 sm:grid-cols-2">{shown.map((b) => box(b.key, b.label))}</div>
        </div>
      )}
    </div>
  );
}

