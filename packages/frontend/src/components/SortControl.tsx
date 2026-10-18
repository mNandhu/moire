import { useRef } from "react";
import { Clock, History, Star, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import type { FeedSort } from "../lib/imageFilter";

const OPTIONS: Array<{ value: FeedSort; label: string; hint: string; icon: LucideIcon }> = [
  { value: "newest", label: "Newest", hint: "Newest first", icon: Clock },
  { value: "oldest", label: "Oldest", hint: "Oldest first", icon: History },
  { value: "top", label: "Top", hint: "Top rated first", icon: Star },
];

/**
 * The gallery's order as a segmented switch: one click (or arrow key) and
 * the highlight slides to the new order. Sits in the toolbar beside Group and
 * Select because changing order is a quick, frequent act, unlike the filter
 * panel. Icons only below xl, like its neighbours.
 */
export function SortControl({
  value,
  onChange,
}: {
  value: FeedSort;
  onChange: (sort: FeedSort) => void;
}) {
  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === value));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    // The gallery moves tile focus on arrow keys from a window listener;
    // the keypress is this control's, so keep it from reaching that.
    e.preventDefault();
    e.stopPropagation();
    const next = (index + step + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Sort"
      onKeyDown={onKeyDown}
      className="relative grid grid-cols-3 h-9 p-0.5 rounded-lg bg-raised border border-line shrink-0"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0.5 left-0.5 rounded-md bg-brand-600/25 border border-brand-500/60 transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ width: "calc((100% - 4px) / 3)", transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o, i) => {
        const on = i === index;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.hint}
            title={o.hint}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative z-[1] inline-flex items-center justify-center gap-1.5 w-8 xl:w-auto xl:px-2.5 rounded-md text-sm font-medium transition-colors",
              on ? "text-brand-100" : "text-muted hover:text-neutral-100",
            )}
          >
            <Icon size={16} className="shrink-0" />
            <span className="hidden xl:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
