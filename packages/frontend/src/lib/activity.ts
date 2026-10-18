/**
 * Generation activity for the Overview chart. The server counts images per
 * local calendar day (`/images/stats`); this folds those into weeks and
 * labels them. Dates are local throughout: "YYYY-MM-DD" from the server
 * already broke at the viewer's midnight in their zone (`viewerTimeZone`).
 */

export type DayCount = { day: string; count: number };

export type WeekBucket = {
  /** Local midnight on the week's Monday. */
  start: Date;
  count: number;
  /** Month name when this week starts a new month ("Oct"); the year instead
   * for January ("2026"), so a year boundary reads at a glance. */
  tick: string | null;
};

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

/** `weeks` buckets ending with the current week, oldest first; empty weeks
 * count 0 so gaps show as gaps. */
export function weeklyActivity(
  days: DayCount[],
  now: Date = new Date(),
  weeks = 52,
): WeekBucket[] {
  const last = mondayOf(now);
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(last);
    start.setDate(start.getDate() - i * 7);
    buckets.push({ start, count: 0, tick: null });
  }
  const index = new Map(buckets.map((b, i) => [b.start.getTime(), i]));
  for (const { day, count } of days) {
    const i = index.get(mondayOf(parseDay(day)).getTime());
    if (i != null) buckets[i].count += count;
  }
  // A week is labeled by the month its Monday falls in; the first bucket is
  // left unlabeled when the next month starts within two weeks (the labels
  // would collide).
  buckets.forEach((b, i) => {
    const m = b.start.getMonth();
    const prev = buckets[i - 1]?.start.getMonth();
    if (i === 0 || m !== prev) {
      b.tick = m === 0 ? String(b.start.getFullYear()) : b.start.toLocaleDateString("en-US", { month: "short" });
    }
  });
  if (buckets[0] && buckets.slice(1, 3).some((b) => b.tick)) buckets[0].tick = null;
  return buckets;
}

/** Images on the last `n` days, today included. */
export function countLastDays(days: DayCount[], n: number, now: Date = new Date()): number {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  return days.reduce((sum, d) => (parseDay(d.day) >= from ? sum + d.count : sum), 0);
}

/** "Week of Oct 12" (with the year when it isn't the current one). */
export function weekLabel(start: Date, now: Date = new Date()): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (start.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `Week of ${start.toLocaleDateString("en-US", opts)}`;
}
