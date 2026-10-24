import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { chartMonths, monthLabel, recentMonths, type TagDetail } from "../../lib/tagBrowse";

/** Images per month: up to two years, the latest month lit. */
export function MonthChart({
  first,
  months: counted,
  accent,
}: {
  first: number | null;
  months: TagDetail["months"];
  /** The bars' colour; the brand's by default. */
  accent?: string;
}) {
  const months = useMemo(() => recentMonths(counted, chartMonths(first)), [counted, first]);
  const peak = Math.max(1, ...months.map((m) => m.count));
  const charted = months.reduce((n, m) => n + m.count, 0);
  return (
    <section>
      <h3 className="text-2xs uppercase tracking-wider text-faint mb-2">
        {months.length} months · {charted.toLocaleString()} {charted === 1 ? "image" : "images"}
      </h3>
      <div className="flex items-end gap-1 h-14" role="img" aria-label={`Images per month over the last ${months.length} months`}>
        {months.map((m, i) => {
          const last = i === months.length - 1;
          return (
            <div
              key={m.month}
              title={`${monthLabel(m.month)}: ${m.count.toLocaleString()}`}
              className={cn(
                "flex-1 rounded-sm",
                !m.count ? "bg-line" : accent ? "" : last ? "bg-brand-300" : "bg-brand-600/70",
              )}
              style={{
                height: m.count ? `${Math.max(8, (m.count / peak) * 100)}%` : "2px",
                ...(m.count && accent ? { background: accent, opacity: last ? 1 : 0.7 } : {}),
              }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-2xs text-faint mt-1">
        <span>{monthLabel(months[0].month)}</span>
        <span>{monthLabel(months[months.length - 1].month)}</span>
      </div>
    </section>
  );
}
