import { RATINGS, type Rating } from "@/lib/rating";

/** The highest level the Global Sensitivity Filter can be set to; showing
 * everything is "off" (null). Mirrors the backend's sensitivity_filter.CHOICES. */
const FILTER_LEVELS = ["general", "sensitive", "questionable"] as const;
export type FilterLevel = (typeof FILTER_LEVELS)[number];

/** GET /sensitivity: the setting, and images by level (out of quarantine). */
export type SensitivityState = {
  max_level: FilterLevel | null;
  counts: { unknown: number; by_level: Record<Rating, number> };
};

/** A tag level this library set (GET /sensitivity/tags). */
export type TagLevel = {
  tag: string;
  level: Rating;
  /** "suggested": imported, not yet checked. */
  source: "user" | "suggested";
  images: number;
};

export type TagLevels = { tags: TagLevel[]; hidden: number };

/** The picker's value for "off". */
export const OFF = "off";

export const FILTER_OPTIONS = [
  { value: OFF, label: "Show everything" },
  { value: "general", label: "General only" },
  { value: "sensitive", label: "Up to sensitive" },
  { value: "questionable", label: "Up to questionable" },
] as const;

export const TAG_LEVEL_OPTIONS = RATINGS.map((r) => ({ value: r, label: r }));

function isFilterLevel(s: string): s is FilterLevel {
  return (FILTER_LEVELS as readonly string[]).includes(s);
}

/** The picker value for a setting, and back. */
export const toOption = (max: FilterLevel | null): string => max ?? OFF;
export const fromOption = (value: string): FilterLevel | null => (isFilterLevel(value) ? value : null);

/** A short label for the setting. */
export function filterLabel(max: FilterLevel | null): string {
  return FILTER_OPTIONS.find((o) => o.value === toOption(max))!.label;
}

/** How many images the setting hides: those above it and those with no
 * level yet. None while it is off. */
export function hiddenCount(state: SensitivityState | undefined): number {
  if (!state?.counts || state.max_level === null) return 0;
  const top = RATINGS.indexOf(state.max_level);
  const above = RATINGS.slice(top + 1).reduce((n, r) => n + (state.counts.by_level[r] ?? 0), 0);
  return above + state.counts.unknown;
}

/** Images hidden only because they have no level yet: AI tagging reveals
 * them (or shows they belong above the filter). */
export function unknownHidden(state: SensitivityState | undefined): number {
  return state?.counts && state.max_level !== null ? state.counts.unknown : 0;
}
