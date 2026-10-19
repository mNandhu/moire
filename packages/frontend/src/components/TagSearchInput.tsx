import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { X, Search } from "lucide-react";
import { fuzzyRank } from "../lib/fuzzy";
import { splitBoilerplate } from "../lib/boilerplate";
import { useBoilerplate } from "../lib/queries";
import { Badge } from "./ui/Badge";
import { cn } from "../lib/cn";
import { formatSearchTag, isManual, isPrompt, tagQueryText } from "../lib/tags";

export type TagSuggestion = { _id: string; count: number };

const MAX_SUGGESTIONS = 8;

type Props = {
  /** Selected tag ids (the chips). */
  value: string[];
  /** Called with the next set of selected tag ids. */
  onChange: (tags: string[]) => void;
  /** Source tags to autocomplete against, with image counts. */
  suggestions: TagSuggestion[];
  placeholder?: string;
};

/**
 * Tag search box: selected tags render as removable chips, and typing fuzzy-
 * matches the known tags into an autocomplete dropdown (each row showing the
 * tag's image count). Enter / click adds the highlighted suggestion; a tag not
 * in the list can still be added by typing it and pressing Enter. Backspace on
 * an empty input removes the last chip.
 */
export const TagSearchInput = forwardRef<HTMLInputElement, Props>(
  function TagSearchInput({ value, onChange, suggestions, placeholder }, ref) {
    const [text, setText] = useState("");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);

    const inputRef = useRef<HTMLInputElement | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    const selected = useMemo(() => new Set(value), [value]);
    const isBoilerplate = useBoilerplate();

    // Fuzzy matches for the current text, excluding already-selected tags.
    const matches = useMemo(() => {
      const q = text.trim();
      if (!q) return [];
      const pool = suggestions.filter((s) => !selected.has(s._id));
      // Boilerplate still matches (it stays searchable) but ranks after every
      // other match, so "best" offers "best friend" before "best quality".
      // Ranked against the display form (spaces), so `blue_eyes` and
      // `blue eyes` find the same tag.
      const ranked = fuzzyRank(tagQueryText(q), pool, (s) => formatSearchTag(s._id), pool.length);
      const { kept, boilerplate } = splitBoilerplate(ranked, (s) => s._id, isBoilerplate);
      return [...kept, ...boilerplate].slice(0, MAX_SUGGESTIONS);
    }, [text, suggestions, selected, isBoilerplate]);

    // Keep the active row in range whenever the match list changes.
    useEffect(() => setActive(0), [text]);

    const showDropdown = open && matches.length > 0;

    const addTag = (tag: string) => {
      const t = tag.trim();
      if (!t || selected.has(t)) {
        setText("");
        return;
      }
      onChange([...value, t]);
      setText("");
      setActive(0);
    };

    const removeTag = (tag: string) =>
      onChange(value.filter((t) => t !== tag));

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown" && showDropdown) {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, matches.length - 1));
      } else if (e.key === "ArrowUp" && showDropdown) {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (showDropdown && matches[active]) addTag(matches[active]._id);
        else if (text.trim()) addTag(text);
      } else if (e.key === "," ) {
        // Treat comma as a commit so old comma-separated muscle memory works.
        e.preventDefault();
        if (text.trim()) addTag(text);
      } else if (e.key === "Backspace" && !text && value.length) {
        removeTag(value[value.length - 1]);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };

    // Close the dropdown on outside click.
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    return (
      <div ref={wrapRef} className="relative">
        <div
          className="flex flex-wrap items-center gap-1.5 w-full rounded-lg bg-neutral-950/70 border border-neutral-800 px-2 py-1.5 text-sm focus-within:border-brand-600/60 transition-colors cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          <Search size={16} className="text-faint ml-1 shrink-0" />
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-brand-900/30 border border-brand-700/60 pl-2 pr-1 py-0.5 text-brand-100"
            >
              <span className="truncate max-w-[12rem]">{formatSearchTag(tag)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(tag);
                }}
                className="rounded hover:bg-brand-700/40 p-0.5 text-brand-300 hover:text-brand-100"
                aria-label={`Remove ${formatSearchTag(tag)}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={value.length ? "" : (placeholder ?? "Search tags…")}
            className="flex-1 min-w-[4rem] bg-transparent px-1 py-0.5 text-neutral-100 placeholder:text-faint outline-none focus-visible:shadow-none"
            role="combobox"
            aria-expanded={showDropdown}
            aria-autocomplete="list"
          />
        </div>

        {showDropdown && (
          <ul
            className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl shadow-black/40 py-1"
            role="listbox"
          >
            {matches.map((s, i) => (
              <li key={s._id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    // mousedown (not click) so it fires before input blur.
                    e.preventDefault();
                    addTag(s._id);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
                    i === active ? "bg-brand-900/30" : "hover:bg-neutral-800/60",
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-neutral-100">
                      {formatSearchTag(s._id)}
                    </span>
                    {isManual(s._id) && (
                      <Badge tone="success" className="text-2xs shrink-0">
                        manual
                      </Badge>
                    )}
                    {isPrompt(s._id) && (
                      <Badge tone="info" className="text-2xs shrink-0">
                        prompt
                      </Badge>
                    )}
                  </span>
                  <span className="tabular-nums text-xs text-faint shrink-0">
                    {s.count.toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
