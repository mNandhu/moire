import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { caretOffset } from "../../lib/caret";
import { cn } from "../../lib/cn";
import { useTagBrowse } from "../../lib/queries";
import { useCharacterNames } from "../../lib/generate";
import { replaceTerm, termAt, type Term } from "../../lib/promptEdit";
import { toPromptText } from "../../lib/tags";
import { TagSuggestList, useTagMatches, type TagSuggestion } from "../TagSuggestList";

const LIST_W = 320;

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
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Term | null>(null);
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const { data: browse } = useTagBrowse("all");
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

  const look = () => {
    const el = ref.current;
    if (!el) return;
    const t = el.selectionStart === el.selectionEnd ? termAt(el.value, el.selectionStart) : null;
    setTerm(t);
    if (t) {
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

  return (
    <div ref={wrapRef} className="relative">
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
        onClick={look}
        onBlur={() => setTimeout(() => setTerm(null), 150)}
        title="Tab completes a suggested tag"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        className={cn(
          "w-full resize-y bg-transparent text-neutral-100 placeholder:text-faint outline-none",
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
    </div>
  );
}
