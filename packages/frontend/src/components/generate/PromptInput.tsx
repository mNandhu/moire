import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { replaceTerm, termAt, type Term } from "../../lib/promptEdit";
import { toPromptText } from "../../lib/tags";
import { TagSuggestList, useTagMatches, type TagSuggestion } from "../TagSuggestList";

/**
 * Free-text prompt with tag and embedding suggestions for the term at the
 * caret. Tab takes the highlighted one; Enter only once the list has been
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
  const resources = useMemo(() => embeddings.map((n) => ({ _id: `embedding:${n}`, count: 0 })), [embeddings]);
  const matches = useTagMatches(term?.query ?? "", suggestions, resources);
  const open = !!term && matches.length > 0;

  const look = () => {
    const el = ref.current;
    if (!el) return;
    setTerm(el.selectionStart === el.selectionEnd ? termAt(el.value, el.selectionStart) : null);
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
      {open && <TagSuggestList matches={matches} active={active} onActive={setActive} onPick={pick} />}
    </div>
  );
}
