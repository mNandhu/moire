import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { Skeleton } from "@/components/ui/Skeleton";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { DiscoverSection } from "@/features/discover/components/DiscoverSection";
import {
  activityCalendar,
  busiestDay,
  countLastDays,
  currentStreak,
  dayLabel,
  lastActive,
  type CalendarCell,
  type DayCount,
} from "@/features/overview/lib/activity";

const LEVEL = [
  "bg-white/[0.05]",
  "bg-brand-500/30",
  "bg-brand-500/55",
  "bg-brand-400/80",
  "bg-brand-300 shadow-[0_0_8px_rgb(167_139_250/0.6)]",
] as const;
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

function Figure({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-2xl font-semibold tabular-nums tracking-tight text-neutral-50">{value}</div>
      <div className="truncate text-xs text-muted">{label}</div>
    </div>
  );
}

/** A year of days, a square each, brighter for busier days. */
function Calendar({ days, now }: { days: DayCount[]; now: Date }) {
  const wide = useMediaQuery("(min-width: 640px)");
  const weeks = useMemo(() => activityCalendar(days, now, wide ? 53 : 26), [days, now, wide]);
  const [hover, setHover] = useState<CalendarCell | null>(null);
  // A month's name over the first week that starts in it.
  const months = weeks.map((w, i) => {
    const m = w[0]?.date.getMonth();
    const prev = weeks[i - 1]?.[0]?.date.getMonth();
    return i > 0 && m !== prev && w[0] ? w[0].date.toLocaleDateString("en-US", { month: "short" }) : null;
  });
  const cols = { gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` };
  return (
    <div>
      <div className="flex gap-2">
        <div className="grid shrink-0 grid-rows-7 gap-[3px] pt-5 text-2xs text-faint" aria-hidden>
          {WEEKDAYS.map((d, i) => (
            <span key={i} className="leading-none flex items-center">{d}</span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative mb-1 grid h-4 gap-[3px] text-2xs text-faint" style={cols} aria-hidden>
            {months.map((m, i) => (
              <span key={i} className="whitespace-nowrap">{m}</span>
            ))}
          </div>
          <div
            className="grid grid-flow-col grid-rows-7 gap-[3px]"
            style={cols}
            role="img"
            aria-label="Images generated per day"
            onMouseLeave={() => setHover(null)}
          >
            {weeks.flatMap((w, i) =>
              w.map((c, d) =>
                c ? (
                  <span
                    key={`${i}-${d}`}
                    onMouseEnter={() => setHover(c)}
                    className={cn(
                      "aspect-square rounded-[3px] transition-[outline] hover:outline hover:outline-1 hover:outline-neutral-200",
                      LEVEL[c.level],
                    )}
                  />
                ) : (
                  <span key={`${i}-${d}`} />
                ),
              ),
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular-nums" aria-live="polite">
          {hover ? (
            <>
              <span className="font-medium text-neutral-100">{dayLabel(hover.date, now)}</span>
              {": "}
              {hover.count ? `${hover.count.toLocaleString()} ${hover.count === 1 ? "image" : "images"}` : "none"}
            </>
          ) : (
            " "
          )}
        </span>
        <span className="flex items-center gap-1" aria-hidden>
          Less
          {LEVEL.map((l, i) => (
            <span key={i} className={cn("h-2.5 w-2.5 rounded-[3px]", l)} />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

/**
 * How much has been made and when: the headline numbers over a calendar
 * of the past year, a square a day, brighter for busier days.
 */
export function ActivityPanel({
  days,
  total,
  className,
}: {
  days?: DayCount[];
  /** Images in the library. */
  total?: number;
  className?: string;
}) {
  const now = useMemo(() => new Date(), []);
  const recent = days ? countLastDays(days, 30, now) : null;
  const streak = days ? currentStreak(days, now) : 0;
  const busiest = days ? busiestDay(days) : null;
  const last = days ? lastActive(days) : null;
  const sinceLast = last ? Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - last.getTime()) / 86_400_000) : 0;
  return (
      <DiscoverSection label="Activity" icon={Activity} tint="fuchsia" className={className}>
        <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {recent == null ? (
            Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-24" />)
          ) : (
            <>
              <Figure value={recent.toLocaleString()} label="Last 30 days" />
              <Figure value={total?.toLocaleString() ?? "…"} label="In the library" />
              <Figure
                value={busiest ? busiest.count.toLocaleString() : "0"}
                label={busiest ? `Busiest day, ${dayLabel(busiest.date, now)}` : "Busiest day"}
              />
              {streak > 0 || !last ? (
                <Figure value={streak} label={streak === 1 ? "Day in a row" : "Days in a row"} />
              ) : (
                <Figure value={sinceLast} label={sinceLast === 1 ? "Day since the last" : "Days since the last"} />
              )}
            </>
          )}
        </div>
        {!days ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          <Calendar days={days} now={now} />
        )}
      </DiscoverSection>
  );
}
