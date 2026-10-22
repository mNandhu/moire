import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/cn";
import { fuzzyRank } from "../../lib/fuzzy";
import { useKeepInViewport } from "../../hooks/useKeepInViewport";

export type PickerOption = {
  value: string;
  label: string;
  /** Quiet text at the row's end (a count, a note). */
  hint?: React.ReactNode;
  /** Drawn before the label (a size preset's outline). */
  icon?: React.ReactNode;
  /** Quieter text right after the label. */
  detail?: string;
  /** Shown faded: there for completeness, nothing behind it yet. */
  dim?: boolean;
  /** Heading the option sits under; consecutive options share it. */
  group?: string;
  /** Indented under the option before it (a workflow's versions). */
  indent?: boolean;
  /** Extra words fuzzy search matches on besides the label. */
  keywords?: string;
};

/** Lists longer than this get a search box. */
const SEARCH_FROM = 8;

/**
 * The app's dropdown: use it instead of a native `<select>` (see CLAUDE.md).
 * A button showing the chosen option opens a list under it; long lists get a
 * search box that fuzzy-matches as you type (`bdhand` finds `badhandv4`).
 * Arrow keys move, Enter picks, Escape closes without reaching the page's
 * own shortcuts. The list renders inline, so a surrounding panel that
 * closes on outside clicks keeps it as its own.
 *
 * Given an array `value`, it picks several: each pick toggles one option
 * (`onChange` gets the option's value) and the list stays open.
 */
export function Picker({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  "aria-label": ariaLabel,
  searchable,
  className,
  trigger,
  align = "left",
  side = "down",
  disabled,
  defaultOpen = false,
  onClose,
  pinned,
  checks = true,
  footer,
}: {
  value: string | readonly string[];
  options: readonly PickerOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  "aria-label"?: string;
  /** Show the search box; by default only for long lists. */
  searchable?: boolean;
  className?: string;
  /** A custom trigger in place of the default field-styled button. */
  trigger?: (props: { open: boolean; label: string | null }) => React.ReactNode;
  align?: "left" | "right";
  /** Open below the trigger, or above it (for controls near the bottom). */
  side?: "down" | "up";
  disabled?: boolean;
  /** Start open (a picker shown in answer to a click elsewhere). */
  defaultOpen?: boolean;
  /** Called when the list closes, picked or not. */
  onClose?: () => void;
  /** An option kept at the top whatever the search ("Create …"); given the search text. */
  pinned?: (query: string) => PickerOption;
  /** Tick the chosen option; without, it is only highlighted. */
  checks?: boolean;
  /** Under the list (an action like "Manage …"); clicking it is the caller's. */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const wasOpen = useRef(open);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (wasOpen.current && !open) onCloseRef.current?.();
    wasOpen.current = open;
  }, [open]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popRef, open);
  const listId = useId();
  const withSearch = searchable ?? options.length > SEARCH_FROM;

  const shown = useMemo(() => {
    const q = query.trim();
    const ranked = q
      ? fuzzyRank(q, options, (o) => (o.keywords ? `${o.label} ${o.keywords}` : o.label), options.length)
      : options;
    return pinned ? [pinned(q), ...ranked] : ranked;
  }, [options, query, pinned]);
  const multiple = typeof value !== "string";
  const isOn = (o: PickerOption) => (multiple ? value.includes(o.value) : o.value === value);
  const chosenLabel = multiple
    ? options.filter(isOn).map((o) => o.label).join(", ") || null
    : (options.find(isOn)?.label ?? null);

  const close = (refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (o: PickerOption) => {
    onChange(o.value);
    if (!multiple) close();
  };

  // Opening starts on the chosen option; typing starts on the best match.
  useEffect(() => {
    if (!open) return;
    // A pinned option leads the list but a search still lands on its best match.
    const first = pinned && shown.length > 1 ? 1 : 0;
    const i = query ? first : Math.max(0, shown.findIndex(isOn));
    setActive(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);
  useEffect(() => {
    if (open && withSearch) searchRef.current?.focus();
    else if (open) listRef.current?.focus();
  }, [open, withSearch]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
      return;
    }
    // While open, keys belong to the list, not the page's shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  return (
    <div ref={wrapRef} className={cn("relative", className)} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          !trigger &&
            "w-full h-9 rounded-lg bg-canvas border border-line px-3 text-sm text-left flex items-center gap-2 hover:border-line-strong focus-visible:border-brand-500/70 transition-colors disabled:opacity-50",
          // A button sizes to its content even as a block: capped, so a
          // custom trigger can cut its label short in a narrow spot.
          trigger && "block max-w-full disabled:cursor-default",
        )}
      >
        {trigger ? (
          trigger({ open, label: chosenLabel })
        ) : (
          <>
            <span className={cn("flex-1 truncate", chosenLabel ? "text-neutral-100" : "text-faint")}>
              {chosenLabel ?? placeholder}
            </span>
            <ChevronDown size={16} className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")} />
          </>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          className={cn(
            "absolute z-50 min-w-full w-max max-w-[min(32rem,calc(100vw-16px))] rounded-lg border border-line-strong bg-raised shadow-panel",
            side === "up" ? "bottom-full mb-1" : "mt-1",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {withSearch && (
            <div className="flex items-center gap-2 px-3 h-9 border-b border-line">
              <Search size={14} className="text-faint shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Search options"
                aria-controls={listId}
                aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
                className="flex-1 min-w-0 bg-transparent text-sm outline-none focus-visible:shadow-none placeholder:text-faint"
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel}
            aria-multiselectable={multiple || undefined}
            aria-activedescendant={!withSearch && shown[active] ? `${listId}-${active}` : undefined}
            className="max-h-72 overflow-auto py-1 outline-none focus-visible:shadow-none"
          >
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-faint">No matches</li>}
            {shown.map((o, i) => {
              // Group headings only in the unfiltered list, where order is meaningful.
              const heading = !query && o.group && o.group !== shown[i - 1]?.group ? o.group : null;
              return (
                <React.Fragment key={o.value}>
                  {heading && (
                    <li role="presentation" className="px-3 pt-2 pb-1 text-2xs uppercase tracking-wider text-faint">
                      {heading}
                    </li>
                  )}
                  <li
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isOn(o)}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(o);
                    }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer",
                      o.indent && !query && "pl-7",
                      i === active ? "bg-brand-900/40" : !checks && isOn(o) && "bg-white/[0.06]",
                      o.dim && "opacity-45",
                    )}
                  >
                    {checks && <span className="w-4 shrink-0 text-brand-300">{isOn(o) && <Check size={14} />}</span>}
                    {o.icon}
                    <span className="flex-1 min-w-0 truncate text-neutral-100">
                      {o.label}
                      {o.detail && <span className="ml-2 text-xs text-faint tabular-nums">{o.detail}</span>}
                    </span>
                    {o.hint != null && <span className="shrink-0 text-xs text-faint tabular-nums">{o.hint}</span>}
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
          {footer && <div className="border-t border-line p-1">{footer}</div>}
        </div>
      )}
    </div>
  );
}
