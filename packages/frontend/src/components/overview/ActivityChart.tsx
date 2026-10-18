import { useMemo } from "react";
import { Section } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { countLastDays, weekLabel, weeklyActivity, type DayCount } from "../../lib/activity";

/**
 * Images generated per week over the past year: one bar per week, in the
 * brand colour only. Answers "how much have I been making, and when", which
 * no single count can.
 */
export function ActivityChart({ days, className }: { days?: DayCount[]; className?: string }) {
  const now = useMemo(() => new Date(), []);
  const weeks = useMemo(() => weeklyActivity(days ?? [], now), [days, now]);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const recent = days ? countLastDays(days, 30, now) : null;

  return (
    <Section
      title="Activity"
      description="Images generated per week, past year"
      actions={
        recent != null && (
          <span className="text-sm text-muted">
            <span className="font-semibold text-neutral-100 tabular-nums">
              {recent.toLocaleString()}
            </span>{" "}
            in the last 30 days
          </span>
        )
      }
      className={className}
    >
      {!days ? (
        <Skeleton className="h-36 w-full" />
      ) : (
        <div>
          <div className="flex items-end gap-[2px] sm:gap-[3px] h-32" role="img" aria-label="Images generated per week">
            {weeks.map((w) => (
              <div
                key={w.start.getTime()}
                className="group relative flex-1 h-full flex items-end"
                title={`${weekLabel(w.start, now)}: ${w.count.toLocaleString()} ${w.count === 1 ? "image" : "images"}`}
              >
                <div
                  className={
                    w.count
                      ? "w-full rounded-sm bg-brand-500/70 group-hover:bg-brand-400 transition-colors"
                      : "w-full h-px bg-line-strong"
                  }
                  style={w.count ? { height: `${Math.max(4, (w.count / max) * 100)}%` } : undefined}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-[2px] sm:gap-[3px] mt-2 h-4 text-2xs text-faint" aria-hidden="true">
            {weeks.map((w) => (
              <div key={w.start.getTime()} className="relative flex-1">
                {w.tick && <span className="absolute left-0 whitespace-nowrap">{w.tick}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
