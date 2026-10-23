import { useMemo, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import { cn } from "../../../lib/cn";
import { fuzzyRank } from "../../../lib/fuzzy";
import { ADDABLE, BOXES, type BoxKey, type Cover, type Placed } from "../../../lib/promptBoard";
import { useDropSide } from "../../../hooks/useDropSide";
import { TagSuggestList } from "../../TagSuggestList";
import type { TagSuggestion } from "../../../lib/tagSuggest";
import { Chip, CoverRow } from "./Chip";

const LIST_ROWS = 40;
// TagSuggestList's own max-h-72, and about one row's height with its padding
// (a described row adds its description's two clamped lines).
const LIST_HEIGHT = 288;
const ROW_HEIGHT = 36;
const DESCRIBED_ROW_HEIGHT = 66;

/** Focus the next part's field after `from` in its board, or let go of the last one. */
function focusNextPart(from: HTMLInputElement) {
  const board = from.closest("[data-part-board]") ?? document;
  const all = [...board.querySelectorAll<HTMLInputElement>("input[data-part-input]")];
  const next = all[all.indexOf(from) + 1];
  if (next) next.focus();
  else from.blur();
}

export function GroupBox({
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
  onClear,
  tone,
  describe,
  glow,
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
  /** Takes out the Prompt's tags here and strikes the layers' (absent when there are none). */
  onClear?: () => void;
  tone?: string;
  /** A tag's description, shown under it in the suggestions. */
  describe: (id: string) => string | undefined;
  /** Lights the box up once (a new value replays it): the app just wrote
   * its tags. */
  glow?: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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
  // On a phone the keyboard leaves little room below: the list goes up then,
  // off the next box, which can be tapped straight away. Sized by what it
  // holds, so a short list that fits below stays there.
  const listHeight = matches.reduce((h, m) => h + (describe(m._id) ? DESCRIBED_ROW_HEIGHT : ROW_HEIGHT), 8);
  const side = useDropSide(boxRef, open, Math.min(LIST_HEIGHT, listHeight));
  const add = (name: string) => {
    if (!name.trim()) return;
    onAdd(name);
    setQ("");
    setActive(-1);
  };
  // A character's own tag is filed under Subject but doesn't say how many.
  const gap = terms.length === 0 && !covers.some((c) => c.terms.some((t) => !t.dropped && !t.self));
  const missing = gap && BOXES.find((b) => b.key === box)?.expected;
  return (
    <div
      ref={boxRef}
      className={cn(
        "group/box relative rounded-lg border px-3 py-2 transition-colors",
        addable && "cursor-text hover:border-line-strong",
        open ? "border-brand-600/70 bg-canvas/80" : (tone ?? (missing ? "border-dashed border-amber-500/40 bg-amber-500/5" : "border-line bg-canvas/60")),
      )}
      onMouseDown={(e) => {
        if (!addable || (e.target as HTMLElement).closest("button, input, [tabindex]")) return;
        e.preventDefault();
        input.current?.focus();
      }}
    >
      {glow != null && <span key={glow} aria-hidden className="pointer-events-none absolute inset-0 rounded-lg animate-written-glow" />}
      <div className="mb-1.5 flex min-h-5 items-center gap-1.5 text-xs font-medium text-muted">
        {label}
        {missing && <span className="text-amber-300">Missing</span>}
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label={`Clear ${label}`}
            title={`Clear ${label}`}
            className="ml-auto rounded p-1 text-faint opacity-0 transition-opacity hover:bg-white/10 hover:text-neutral-100 focus-visible:opacity-100 group-hover/box:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Eraser size={13} />
          </button>
        )}
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
            data-part-input
            // Empty, Enter moves on to the next part (the phone keyboard's
            // Next), so filling them in turn needs no tap in between.
            enterKeyHint={q.trim() ? "enter" : "next"}
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
                if (active < 0 && !q.trim()) focusNextPart(e.currentTarget);
                else add(active >= 0 && matches[active] ? matches[active]._id : q);
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
        <TagSuggestList
          matches={matches}
          active={active}
          onActive={setActive}
          onPick={(m) => add(m._id)}
          thumbOf={thumbOf}
          descriptionOf={describe}
          className={cn("left-0 z-30", side.up ? "bottom-full mt-0 mb-1" : "top-full")}
          style={{ maxHeight: side.max }}
        />
      )}
    </div>
  );
}
