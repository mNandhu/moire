import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { caretOffset } from "../../lib/caret";
import { useTagBrowse } from "../../lib/queries";
import { useCharacterNames } from "../../lib/generate";
import { replaceTerm, termAt, type Term } from "../../lib/promptEdit";
import { toPromptText } from "../../lib/tags";
import { useTagMatches, type TagSuggestion } from "../TagSuggestList";

const LIST_W = 320;

/**
 * Tag and embedding suggestions for the term at the textarea's caret: the
 * term, its matches, where the list opens, picking one, and the list's keys.
 * `look` re-reads the caret (call it after typing and clicking); `close`
 * drops the term; `onKeyDown` handles the keys only while the list is open.
 */
export function usePromptSuggest({
  textareaRef,
  wrapRef,
  value,
  onChange,
  suggestions,
  embeddings,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapRef: RefObject<HTMLDivElement | null>;
  value: string;
  onChange: (v: string) => void;
  suggestions: readonly TagSuggestion[];
  embeddings: readonly string[];
}) {
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

  const look = () => {
    const el = textareaRef.current;
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
  }, [open, wrapRef]);

  const pick = (s: TagSuggestion) => {
    if (!term) return;
    const word = s._id.startsWith("embedding:") ? s._id : toPromptText([s._id]);
    const next = replaceTerm(value, term, word);
    onChange(next.text);
    setTerm(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    // Ctrl/Cmd+Arrow is not the list's: those keys stay free for the prompt
    // field's own shortcuts.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.ctrlKey && !e.metaKey) {
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

  return {
    open,
    look,
    close: () => setTerm(null),
    onKeyDown,
    listProps: {
      matches,
      active,
      onActive: setActive,
      onPick: pick,
      thumbOf,
      noteOf,
      style: at ? { left: at.left, top: at.top } : undefined,
    },
  };
}
