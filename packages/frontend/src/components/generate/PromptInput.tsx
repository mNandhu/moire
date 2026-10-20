import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { caretOffset } from "../../lib/caret";
import { cn } from "../../lib/cn";
import { useTagBrowse } from "../../lib/queries";
import { useCharacterNames } from "../../lib/generate";
import { replaceTerm, termAt, type Term } from "../../lib/promptEdit";
import { toPromptText } from "../../lib/tags";
import { TagSuggestList, useTagMatches, type TagSuggestion } from "../TagSuggestList";

const LIST_W = 320;

export type PromptMark = { start: number; end: number; reason: string };
const NO_MARKS: readonly PromptMark[] = [];

/**
 * Free-text prompt with tag and embedding suggestions for the term at the
 * caret, opened right under the word being typed, with each tag's cover. Tab takes the highlighted one; Enter only once the list has been
 * moved into with the arrow keys, so a typed word (a LoRA trigger) is never
 * swapped for a near match.
 */
export function PromptInput({
  value,
  onChange,
  suggestions,
  embeddings,
  label,
  rows = 6,
  invalid,
  className,
  placeholder,
  marks = NO_MARKS,
  fix,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: readonly TagSuggestion[];
  embeddings: readonly string[];
  label: string;
  rows?: number;
  invalid?: boolean;
  className?: string;
  placeholder?: string;
  /** Terms to outline in amber, each with why; hovering one (or putting the
   * caret in it) opens a bubble with the reason and `fix`. */
  marks?: readonly PromptMark[];
  fix?: { label: string; apply: () => void } | null;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Term | null>(null);
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // Covers come from the Tags page list: a big one, so only fetched once
  // suggestions have been shown.
  const [wantCovers, setWantCovers] = useState(false);
  const { data: browse } = useTagBrowse("all", { enabled: wantCovers });
  const thumbs = useMemo(() => new Map((browse ?? []).map((b) => [b.tag, b.thumb_url])), [browse]);
  const thumbOf = useCallback((id: string) => thumbs.get(id) ?? null, [thumbs]);
  const resources = useMemo(() => embeddings.map((n) => ({ _id: `embedding:${n}`, count: 0 })), [embeddings]);
  // Characters the tagger knows that the library doesn't have yet, offered
  // after the library's own tags (no count, no cover).
  const { data: names } = useCharacterNames();
  const unseen = useMemo(() => {
    const have = new Set(suggestions.map((x) => x._id));
    return new Set((names ?? []).filter((n) => !have.has(n)));
  }, [names, suggestions]);
  const pool = useMemo(() => [...suggestions, ...[...unseen].map((_id) => ({ _id, count: 0 }))], [suggestions, unseen]);
  const noteOf = useCallback((id: string) => (unseen.has(id) ? "not in library" : null), [unseen]);
  const matches = useTagMatches(term?.query ?? "", pool, resources);
  const open = !!term && matches.length > 0;

  // Marked terms: drawn on a copy of the text behind the (transparent)
  // textarea, so they wrap and scroll with it.
  const backRef = useRef<HTMLDivElement>(null);
  const markRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [bubbleAt, setBubbleAt] = useState<{ left: number; top: number } | null>(null);
  const markAt = (i: number | null) => {
    const span = i == null ? null : markRefs.current[i];
    const el = ref.current;
    if (i == null || !span || !el) {
      setShown(null);
      return;
    }
    setShown(i);
    const room = (wrapRef.current?.clientWidth ?? el.clientWidth) - 288;
    setBubbleAt({
      left: Math.max(0, Math.min(span.offsetLeft, room)),
      top: el.offsetTop + span.offsetTop - el.scrollTop + span.offsetHeight + 4,
    });
  };
  const markUnder = (x: number, y: number) =>
    markRefs.current.findIndex((m) =>
      m ? [...m.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) : false,
    );
  const markAtCaret = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return -1;
    const c = el.selectionStart;
    return marks.findIndex((m) => c >= m.start && c <= m.end);
  };
  // Any change to the marks closes the bubble: its index and place are stale.
  const marksKey = marks.map((m) => `${m.start}:${m.end}:${m.reason}`).join("|");
  useEffect(() => {
    markRefs.current = markRefs.current.slice(0, marks.length);
    setShown(null);
  }, [marksKey, marks.length]);
  // The copy behind wraps at the textarea's content width (a scrollbar
  // narrows it) and follows its scroll.
  const syncBack = useCallback(() => {
    const el = ref.current;
    const back = backRef.current;
    if (!el || !back) return;
    back.style.width = `${el.clientWidth}px`;
    back.style.height = `${el.clientHeight}px`;
    back.scrollTop = el.scrollTop;
  }, []);
  useLayoutEffect(syncBack, [syncBack, value, marksKey]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !marks.length) return;
    const ro = new ResizeObserver(syncBack);
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncBack, marks.length]);

  const look = () => {
    const el = ref.current;
    if (!el) return;
    const t = el.selectionStart === el.selectionEnd ? termAt(el.value, el.selectionStart) : null;
    setTerm(t);
    if (t) {
      setWantCovers(true);
      // Under the start of the word, kept inside the field's width.
      const lead = el.value.slice(t.start, t.end).length - el.value.slice(t.start, t.end).trimStart().length;
      const c = caretOffset(el, t.start + lead);
      const room = (wrapRef.current?.clientWidth ?? el.clientWidth) - LIST_W;
      setAt({ left: Math.max(0, Math.min(c.left, room)), top: el.offsetTop + c.top + c.height + 2 });
    }
    setActive(0);
    setMoved(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setTerm(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const pick = (s: TagSuggestion) => {
    if (!term) return;
    const word = s._id.startsWith("embedding:") ? s._id : toPromptText([s._id]);
    const next = replaceTerm(value, term, word);
    onChange(next.text);
    setTerm(null);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && shown != null && !open) {
      e.stopPropagation();
      setShown(null);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setMoved(true);
      setActive((a) => (e.key === "ArrowDown" ? Math.min(a + 1, matches.length - 1) : Math.max(a - 1, 0)));
    } else if (e.key === "Tab" || (e.key === "Enter" && moved)) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setTerm(null);
    }
  };

  const mark = shown != null && !open ? marks[shown] : null;
  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setShown(null)}>
      {marks.length > 0 && (
        <div
          ref={backRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words text-transparent",
            className,
          )}
        >
          {marks.map((m, i) => (
            <span key={`${m.start}:${m.end}`}>
              {value.slice(i ? marks[i - 1].end : 0, m.start)}
              <span
                ref={(el) => {
                  markRefs.current[i] = el;
                }}
                className="rounded-sm bg-amber-400/10 shadow-[0_0_0_1px_rgb(251_191_36/0.8)]"
              >
                {value.slice(m.start, m.end)}
              </span>
            </span>
          ))}
          {value.slice(marks[marks.length - 1].end)}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(look);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") markAt(markAtCaret());
        }}
        onClick={() => {
          look();
          markAt(markAtCaret());
        }}
        onScroll={() => {
          syncBack();
          setShown(null);
        }}
        onMouseMove={(e) => {
          if (!marks.length) return;
          const i = markUnder(e.clientX, e.clientY);
          if (i >= 0 && i !== shown) markAt(i);
        }}
        onBlur={() => setTimeout(() => setTerm(null), 150)}
        title="Tab completes a suggested tag"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className={cn(
          "relative w-full resize-y bg-transparent text-neutral-100 placeholder:text-faint outline-none",
          invalid && "text-red-200",
          className,
        )}
      />
      {open && (
        <TagSuggestList
          matches={matches}
          active={active}
          onActive={setActive}
          onPick={pick}
          thumbOf={thumbOf}
          noteOf={noteOf}
          className="mt-0 w-80"
          style={at ? { left: at.left, top: at.top } : undefined}
        />
      )}
      {mark && bubbleAt && (
        <div
          role="note"
          className="absolute z-30 w-72 rounded-lg border border-amber-700/60 bg-raised p-2.5 text-xs text-neutral-200 shadow-panel"
          style={{ left: bubbleAt.left, top: bubbleAt.top }}
        >
          <p>{mark.reason}</p>
          {fix && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                fix.apply();
                setShown(null);
              }}
              className="mt-2 rounded-md border border-amber-700/70 bg-amber-900/30 px-2 py-1 text-amber-100 hover:bg-amber-900/50"
            >
              {fix.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
