// Local calendar days, for the date picker and date filters. Pure: `now`
// is passed in where it matters, so tests can pin it.

/** Local midnight of `d`'s day. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** `d`'s day moved by `n` days (local, DST-safe). */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** `d` moved by `n` months, its day kept where the month has it, else the
 * month's last (Jan 31 + 1 is Feb 28, not Mar 3). */
export function addMonths(d: Date, n: number): Date {
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last));
}

/** Same local calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Epoch seconds of a local date. */
export const toSeconds = (d: Date) => d.getTime() / 1000;

/** The local date at epoch seconds `s`. */
export const fromSeconds = (s: number) => new Date(s * 1000);

/** The six weeks (Monday first) a month's grid shows: the month's days and
 * the neighbours' around them. */
export function monthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - lead + i));
}

/** "Nov 12, 2026". */
export function formatDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
