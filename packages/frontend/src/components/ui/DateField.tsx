import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useDismiss } from "@/hooks/useDismiss";
import { useKeepInViewport } from "@/hooks/useKeepInViewport";
import { cn } from "@/lib/cn";
import { addDays, addMonths, formatDay, monthGrid, sameDay, startOfDay } from "@/lib/dates";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * The app's date input: use it instead of a native `<input type="date">`,
 * whose picker the browser draws (see CLAUDE.md). A field-styled button
 * showing the day opens a month under it. Arrow keys move a day or a week,
 * Page Up / Down a month, Home / End the week's ends, Enter picks, Escape
 * closes. Days after `max` can't be picked; the x clears it.
 */
export function DateField({
  value,
  onChange,
  placeholder = "Any day",
  "aria-label": ariaLabel,
  max,
  className,
}: {
  value: Date | null;
  onChange: (day: Date | null) => void;
  placeholder?: string;
  "aria-label": string;
  /** The last day that can be picked. */
  max?: Date;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The day the keyboard is on; the month shown follows it.
  const [cursor, setCursor] = useState(() => startOfDay(value ?? new Date()));
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popRef, open);
  useDismiss([wrapRef, popRef], () => setOpen(false), open, { escape: false });

  const today = startOfDay(new Date());
  const last = max ? startOfDay(max) : null;
  const allowed = (d: Date) => !last || d <= last;

  const show = () => {
    setCursor(startOfDay(value ?? (last && today > last ? last : today)));
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const pick = (d: Date) => {
    if (!allowed(d)) return;
    onChange(d);
    close();
  };

  // The keyboard's day takes the focus as it moves.
  useEffect(() => {
    if (!open) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${cursor.getTime()}"]`)?.focus();
  }, [open, cursor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    e.stopPropagation();
    const move: Record<string, () => Date> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => addMonths(cursor, -1),
      PageDown: () => addMonths(cursor, 1),
      Home: () => addDays(cursor, -((cursor.getDay() + 6) % 7)),
      End: () => addDays(cursor, 6 - ((cursor.getDay() + 6) % 7)),
    };
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (move[e.key]) {
      e.preventDefault();
      // Never onto a day that can't be picked (it can't take the focus).
      const next = move[e.key]();
      setCursor(last && next > last ? last : next);
    }
  };
  // Tab moves through the calendar (its month buttons, Today, Clear); it
  // closes once the focus leaves it.
  const onBlur = (e: React.FocusEvent) => {
    if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  const month = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const days = monthGrid(month.getFullYear(), month.getMonth());
  const shift = (n: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1));
  const nextMonthAllowed = !last || new Date(month.getFullYear(), month.getMonth() + 1, 1) <= last;

  return (
    <div ref={wrapRef} className={cn("relative", className)} onKeyDown={onKeyDown} onBlur={onBlur}>
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-label={value ? `${ariaLabel}: ${formatDay(value)}` : ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close() : show())}
          className="w-full h-9 rounded-lg bg-canvas border border-line pl-3 pr-9 text-sm text-left flex items-center gap-2 hover:border-line-strong focus-visible:border-brand-500/70 transition-colors"
        >
          <CalendarDays size={15} className="shrink-0 text-faint" />
          <span className={cn("flex-1 truncate tabular-nums", value ? "text-neutral-100" : "text-faint")}>
            {value ? formatDay(value) : placeholder}
          </span>
        </button>
        {value && (
          <button
            type="button"
            aria-label={`Clear ${ariaLabel.toLowerCase()}`}
            onClick={() => onChange(null)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 grid h-6 w-6 place-items-center rounded-md text-faint hover:bg-white/10 hover:text-neutral-100"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={ariaLabel}
          // A press inside keeps the focus where it is: on a day, it would
          // move the month under the pointer before the click lands; on a
          // gap, it would leave the calendar and close it.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-0 z-50 mt-1 w-72 rounded-lg border border-line-strong bg-raised p-3 shadow-panel"
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => shift(-1)}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-white/10 hover:text-neutral-100"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold text-neutral-100" aria-live="polite">
              {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => shift(1)}
              disabled={!nextMonthAllowed}
              className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-white/10 hover:text-neutral-100 disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-2xs text-faint" aria-hidden>
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1">{d}</span>
            ))}
          </div>
          <div ref={gridRef} className="grid grid-cols-7 gap-0.5" role="group" aria-label={month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}>
            {days.map((d) => {
              const inMonth = d.getMonth() === month.getMonth();
              const chosen = !!value && sameDay(d, value);
              const isCursor = sameDay(d, cursor);
              const ok = allowed(d);
              return (
                <button
                  key={d.getTime()}
                  type="button"
                  data-day={d.getTime()}
                  tabIndex={isCursor ? 0 : -1}
                  disabled={!ok}
                  aria-label={formatDay(d)}
                  aria-pressed={chosen}
                  onClick={() => pick(d)}
                  onFocus={() => !isCursor && setCursor(d)}
                  className={cn(
                    "h-8 rounded-md text-sm tabular-nums outline-none transition-colors",
                    inMonth ? "text-neutral-200" : "text-faint/60",
                    ok && !chosen && "hover:bg-white/10",
                    chosen && "bg-brand-500 font-semibold text-white",
                    !chosen && sameDay(d, today) && "ring-1 ring-inset ring-brand-400/60",
                    isCursor && !chosen && "bg-white/[0.08]",
                    "focus-visible:ring-2 focus-visible:ring-brand-300",
                    !ok && "cursor-default opacity-30",
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between border-t border-line pt-2">
            <button
              type="button"
              onClick={() => pick(today)}
              disabled={!allowed(today)}
              className="rounded-md px-2 py-1 text-xs text-brand-200 hover:bg-white/10 disabled:opacity-40"
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                  close();
                }}
                className="rounded-md px-2 py-1 text-xs text-muted hover:bg-white/10 hover:text-neutral-100"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
