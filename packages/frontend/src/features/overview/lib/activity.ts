/**
 * Generation activity for the Overview calendar. The server counts images
 * per local calendar day (`/images/stats`); this lays those out by week and
 * sums them up. Dates are local throughout: "YYYY-MM-DD" from the server
 * already broke at the viewer's midnight in their zone (`viewerTimeZone`).
 */

export type DayCount = { day: string; count: number };

/** The viewer's IANA zone ("Asia/Kolkata"), the server's `tz`. A zone, not
 * today's offset, so dates on the far side of a DST change land right. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function mondayOf(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

/** Images on the last `n` days, today included. */
export function countLastDays(days: DayCount[], n: number, now: Date = new Date()): number {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  return days.reduce((sum, d) => (parseDay(d.day) >= from ? sum + d.count : sum), 0);
}

export type CalendarCell = { date: Date; count: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * The activity calendar: `weeks` columns of seven days (Monday first),
 * ending with the current week, oldest first. Days after today are null.
 * Each day's `level` is its count against the busy days: 0 none, then the
 * quarter of the non-empty days' counts it falls in, so one huge day
 * doesn't wash every other day out; the busiest day is 4.
 */
export function activityCalendar(
  days: DayCount[],
  now: Date = new Date(),
  weeks = 53,
): (CalendarCell | null)[][] {
  const byDay = new Map(days.map((d) => [parseDay(d.day).getTime(), d.count]));
  const counts = days.map((d) => d.count).filter((n) => n > 0).sort((a, b) => a - b);
  const cut = (q: number) => counts[Math.floor(q * (counts.length - 1))] ?? 0;
  const cuts = [cut(0.25), cut(0.5), cut(0.75)];
  const max = counts[counts.length - 1] ?? 0;
  // The busiest day is always the brightest: with few busy days (or all
  // alike) the quarters collapse and would leave it dim.
  const level = (n: number): CalendarCell["level"] =>
    n <= 0 ? 0 : n >= max ? 4 : n <= cuts[0] ? 1 : n <= cuts[1] ? 2 : n <= cuts[2] ? 3 : 4;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const first = mondayOf(now);
  first.setDate(first.getDate() - (weeks - 1) * 7);
  const out: (CalendarCell | null)[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: (CalendarCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(first.getFullYear(), first.getMonth(), first.getDate() + w * 7 + d);
      if (date.getTime() > today) {
        col.push(null);
        continue;
      }
      const count = byDay.get(date.getTime()) ?? 0;
      col.push({ date, count, level: level(count) });
    }
    out.push(col);
  }
  return out;
}

/** Days in a row with images, ending today (or yesterday, when today has
 * none yet: a streak isn't broken before the day is out). */
export function currentStreak(days: DayCount[], now: Date = new Date()): number {
  const active = new Set(days.filter((d) => d.count > 0).map((d) => parseDay(d.day).getTime()));
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!active.has(day.getTime())) day.setDate(day.getDate() - 1);
  let n = 0;
  while (active.has(day.getTime())) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

/** The day with the most images, null when there are none. */
export function busiestDay(days: DayCount[]): { date: Date; count: number } | null {
  let best: DayCount | null = null;
  for (const d of days) if (d.count > 0 && (!best || d.count > best.count)) best = d;
  return best ? { date: parseDay(best.day), count: best.count } : null;
}

/** "Nov 12" (with the year when it isn't the current one). */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-US", opts);
}

/** The last day with images, null when there are none. */
export function lastActive(days: DayCount[]): Date | null {
  let last: Date | null = null;
  for (const d of days) {
    if (d.count <= 0) continue;
    const at = parseDay(d.day);
    if (!last || at > last) last = at;
  }
  return last;
}
