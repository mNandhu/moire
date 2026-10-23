import { useRef } from "react";
import { cn } from "../../lib/cn";
import { TagSuggestList, type TagSuggestion } from "../TagSuggestList";
import { usePromptMarks, type PromptFlash, type PromptMark } from "./PromptOverlay";
import { usePromptSuggest } from "./usePromptSuggest";

export type { PromptFlash, PromptMark };

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
  flash,
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
  flash?: PromptFlash | null;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const suggest = usePromptSuggest({ textareaRef: ref, wrapRef, value, onChange, suggestions, embeddings });
  const overlay = usePromptMarks({
    textareaRef: ref,
    wrapRef,
    value,
    marks,
    fix,
    flash,
    className,
    suggestOpen: suggest.open,
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (overlay.onEscape(e)) return;
    suggest.onKeyDown(e);
  };

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={overlay.hide}>
      {overlay.backdrop}
      <textarea
        ref={ref}
        aria-label={label}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(suggest.look);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={overlay.onKeyUp}
        onClick={() => {
          suggest.look();
          overlay.onClick();
        }}
        onScroll={overlay.onScroll}
        onMouseMove={overlay.onMouseMove}
        onBlur={() => setTimeout(suggest.close, 150)}
        title="Tab completes a suggested tag"
        role="combobox"
        aria-expanded={suggest.open}
        aria-autocomplete="list"
        className={cn(
          "relative w-full resize-y bg-transparent text-neutral-100 placeholder:text-faint outline-none",
          invalid && "text-red-200",
          className,
        )}
      />
      {suggest.open && <TagSuggestList {...suggest.listProps} className="mt-0 w-80" />}
      {overlay.popovers}
    </div>
  );
}
