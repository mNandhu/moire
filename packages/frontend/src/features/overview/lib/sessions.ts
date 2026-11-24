/**
 * Overview's sessions: the newest images split where the library went
 * quiet for a while, so an evening's work is one session whatever prompts
 * and batches it held.
 */

/** A pause longer than this ends a session. */
const SESSION_GAP_SECONDS = 45 * 60;

export type Session<T> = {
  items: T[];
  start: number | null;
  end: number | null;
  /** It may run on past the images fetched: its start and count are a floor. */
  partial?: boolean;
};

/** `items` (newest first) cut where two images are more than `gap` seconds
 * apart. With `complete` false the oldest session may run on past the
 * items fetched, so it is left out rather than shown short; when it is the
 * only one, it is kept and marked `partial`. */
export function splitSessions<T extends { mtime: number | null }>(
  items: readonly T[],
  complete: boolean,
  gap: number = SESSION_GAP_SECONDS,
): Session<T>[] {
  const out: Session<T>[] = [];
  let cur: Session<T> | null = null;
  for (const it of items) {
    const t = it.mtime;
    if (!cur || (t != null && cur.start != null && cur.start - t > gap)) {
      cur = { items: [], start: t, end: t };
      out.push(cur);
    }
    cur.items.push(it);
    if (t != null) {
      cur.start = cur.start == null ? t : Math.min(cur.start, t);
      cur.end = cur.end == null ? t : Math.max(cur.end, t);
    }
  }
  if (!complete && out.length > 1) out.pop();
  else if (!complete && out.length === 1) out[0].partial = true;
  return out;
}

/** "Today", "Yesterday", a weekday within the week, else "Nov 12" (with the
 * year when it isn't this one). From a file mtime in epoch seconds. */
export function sessionDay(mtime: number | null, now: Date = new Date()): string {
  if (mtime == null) return "Earlier";
  const d = new Date(mtime * 1000);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ago = Math.round((today - day) / 86_400_000);
  if (ago <= 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/** "6:58 PM" in the viewer's clock. */
function sessionTime(mtime: number | null): string {
  if (mtime == null) return "";
  return new Date(mtime * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "5:10 PM to 6:58 PM", or one time when it was a moment; "until 6:58 PM"
 * when its start wasn't fetched. */
export function sessionSpan(s: { start: number | null; end: number | null; partial?: boolean }): string {
  if (s.partial) return `until ${sessionTime(s.end)}`;
  const a = sessionTime(s.start);
  const b = sessionTime(s.end);
  return a === b || !a ? b : `${a} to ${b}`;
}

/** Runs of `items` from the same day (by `at`, an mtime), in order. */
export function byDay<T>(
  items: readonly T[],
  at: (it: T) => number | null,
  now: Date = new Date(),
): { day: string; items: T[] }[] {
  const out: { day: string; items: T[] }[] = [];
  for (const it of items) {
    const day = sessionDay(at(it), now);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}

/** The latest day's sessions as one (what the banner shows: a day's work,
 * not its last few minutes), and the sessions of the days before it. */
export function latestDay<T>(sessions: readonly Session<T>[], now: Date = new Date()): {
  latest: Session<T> | undefined;
  earlier: Session<T>[];
} {
  if (!sessions.length) return { latest: undefined, earlier: [] };
  const day = sessionDay(sessions[0].end, now);
  let i = 0;
  while (i < sessions.length && sessionDay(sessions[i].end, now) === day) i++;
  const same = sessions.slice(0, i);
  const latest: Session<T> = {
    items: same.flatMap((s) => s.items),
    start: same[same.length - 1].start,
    end: same[0].end,
    partial: same.some((s) => s.partial),
  };
  return { latest, earlier: sessions.slice(i) };
}

/** A session's best image: the top scored, else (scores tied or missing)
 * the newest, as `items` come newest first. */
export function bestOf<T extends { score: number | null }>(items: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const it of items) if (!best || (it.score ?? -1) > (best.score ?? -1)) best = it;
  return best;
}

/** Who a session is named for: the character in at least half of its
 * images (`made`, most first, with their image ids), else nobody. A
 * character in two images of forty doesn't make it theirs. */
export function sessionCharacter<M extends { tag: string; count: number; image_ids?: string[] }>(
  made: readonly M[] | undefined,
  size: number,
): M | undefined {
  const top = made?.[0];
  return top && size > 0 && top.count * 2 >= size ? top : undefined;
}
