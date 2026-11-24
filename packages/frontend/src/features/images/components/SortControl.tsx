import { useLayoutEffect, useRef, useState } from "react";
import { Clock, History, RefreshCw, Shuffle, Star, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import type { FeedSort } from "@/features/images/lib/imageFilter";

export const SORT_OPTIONS: Array<{ value: FeedSort; label: string; hint: string; icon: LucideIcon }> = [
  { value: "newest", label: "Newest", hint: "Newest first", icon: Clock },
  { value: "oldest", label: "Oldest", hint: "Oldest first", icon: History },
  { value: "top", label: "Top", hint: "Top rated first", icon: Star },
  { value: "shuffle", label: "Shuffle", hint: "Shuffled", icon: Shuffle },
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
  onReshuffle,
  reshuffling = false,
}: {
  value: FeedSort;
  onChange: (sort: FeedSort) => void;
  /** Deal a new shuffled order: what Shuffle does when it is already on. */
  onReshuffle?: () => void;
  reshuffling?: boolean;
}) {
  const index = Math.max(0, SORT_OPTIONS.findIndex((o) => o.value === value));
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // Each option is as wide as its own label (equal columns left "Top"
  // floating in a gap), so the highlight measures the one it sits under.
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[index];
    if (!el) return;
    const measure = () => setBox({ left: el.offsetLeft, width: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    // The gallery moves tile focus on arrow keys from a window listener;
    // the keypress is this control's, so keep it from reaching that.
    e.preventDefault();
    e.stopPropagation();
    const next = (index + step + SORT_OPTIONS.length) % SORT_OPTIONS.length;
    onChange(SORT_OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Sort"
      onKeyDown={onKeyDown}
      className="relative flex h-9 p-0.5 rounded-lg bg-raised border border-line shrink-0"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0.5 left-0 rounded-md bg-brand-600/25 border border-brand-500/60 transition-[transform,width] duration-200 ease-out motion-reduce:transition-none",
          !box && "hidden",
        )}
        style={box ? { width: box.width, transform: `translateX(${box.left}px)` } : undefined}
      />
      {SORT_OPTIONS.map((o, i) => {
        const on = i === index;
        // Shuffle, once on, deals again in place: no extra button that
        // would widen the toolbar only in this order.
        const deal = on && o.value === "shuffle" && onReshuffle;
        const Icon = deal ? RefreshCw : o.icon;
        const hint = deal ? "Reshuffle" : o.hint;
        return (
          <Tooltip key={o.value} content={hint} bubble>
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={hint}
              tabIndex={on ? 0 : -1}
              onClick={() => (deal ? !reshuffling && onReshuffle() : onChange(o.value))}
              className={cn(
                "relative z-[1] inline-flex items-center justify-center gap-1.5 w-8 xl:w-auto xl:px-2.5 rounded-md text-sm font-medium transition-colors",
                on ? "text-brand-100" : "text-muted hover:text-neutral-100",
              )}
            >
              <Icon size={16} className={cn("shrink-0", deal && reshuffling && "animate-spin")} />
              <span className="hidden xl:inline">{o.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
