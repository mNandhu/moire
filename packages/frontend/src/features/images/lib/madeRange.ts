// The gallery's Made filter: presets over the made_from / made_to range
// (epoch seconds, `madeTo` exclusive), and the custom range's days.

import { addDays, fromSeconds, startOfDay, toSeconds } from "@/lib/dates";
import type { Filters } from "./imageFilter";

export type MadeRange = { madeFrom?: number; madeTo?: number };

export const MADE_PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "year", label: "This year" },
] as const;
export type MadePreset = (typeof MADE_PRESETS)[number]["value"];

/** A preset's range from `now`: whole local days. The "last" ones and This
 * year run on to now (no end), so a new image still shows. A preset is a
 * shortcut to a range: the URL holds the dates, so a link kept for later
 * shows the same days (its chip names them) and reads as a custom range. */
export function presetRange(p: MadePreset, now: Date = new Date()): MadeRange {
  const today = startOfDay(now);
  switch (p) {
    case "today":
      return { madeFrom: toSeconds(today), madeTo: toSeconds(addDays(today, 1)) };
    case "yesterday":
      return { madeFrom: toSeconds(addDays(today, -1)), madeTo: toSeconds(today) };
    case "7d":
      return { madeFrom: toSeconds(addDays(today, -6)) };
    case "30d":
      return { madeFrom: toSeconds(addDays(today, -29)) };
    case "year":
      return { madeFrom: toSeconds(new Date(now.getFullYear(), 0, 1)) };
  }
}

/** Which preset `f`'s range is today, if any. */
export function presetOf(f: MadeRange, now: Date = new Date()): MadePreset | undefined {
  return MADE_PRESETS.find(({ value }) => {
    const r = presetRange(value, now);
    return r.madeFrom === f.madeFrom && r.madeTo === f.madeTo;
  })?.value;
}

/** The custom range's From day, and its To day (inclusive: `madeTo` is the
 * next day's midnight). */
export function rangeDays(f: MadeRange): { from: Date | null; to: Date | null } {
  return {
    from: f.madeFrom != null ? startOfDay(fromSeconds(f.madeFrom)) : null,
    to: f.madeTo != null ? startOfDay(fromSeconds(f.madeTo - 1)) : null,
  };
}

/** The range from a From and To day (either may be unset); a To before the
 * From moves the From back to it. */
export function rangeOf(from: Date | null, to: Date | null): Pick<Filters, "madeFrom" | "madeTo"> {
  const f = from && to && to < from ? to : from;
  return {
    madeFrom: f ? toSeconds(startOfDay(f)) : undefined,
    madeTo: to ? toSeconds(addDays(startOfDay(to), 1)) : undefined,
  };
}
