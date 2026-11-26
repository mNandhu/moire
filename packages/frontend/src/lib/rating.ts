/** The ratings an image can have, mildest first; "-" is unrated. Mirrors the
 * backend's image_tags.RATINGS (tests/test_mirrored_vocab.py). */
export const RATINGS = ["general", "sensitive", "questionable", "explicit"] as const;
export type Rating = (typeof RATINGS)[number];

function isRating(s: string): s is Rating {
  return (RATINGS as readonly string[]).includes(s);
}

/** The rating picker's choices: Unrated, then each rating. */
export const RATING_OPTIONS = [
  { value: "-", label: "Unrated" },
  ...RATINGS.map((r) => ({ value: r, label: r })),
];

/**
 * The rating to display for an image: the explicit `rating` if set, else the
 * highest-scoring label from the AI rating map, else "-". Pure precedence logic
 * lifted out of ImageView so it has a test surface.
 */
/** What pickRating reads off an image (an ImageDetail fits). */
type RatedImage = { rating?: string | null; ai?: { rating?: Record<string, number> } | null };

export function pickRating(doc: RatedImage | null | undefined): string {
  const r = (doc?.rating || "").trim();
  if (r) return r;
  const m = doc?.ai?.rating;
  if (m && typeof m === "object") {
    let bestKey: string | null = null;
    let bestVal = -Infinity;
    for (const [k, v] of Object.entries(m)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n > bestVal) {
        bestVal = n;
        bestKey = k;
      }
    }
    if (bestKey) return bestKey;
  }
  return "-";
}

/** Badge colours per rating (see ratingBadgeClass). */
const RATING_BADGE: Record<Rating, string> = {
  general: "bg-emerald-900/30 border-emerald-800 text-emerald-100",
  sensitive: "bg-amber-900/30 border-amber-800 text-amber-100",
  questionable: "bg-orange-900/30 border-orange-800 text-orange-100",
  explicit: "bg-red-900/30 border-red-800 text-red-100",
};

/** Tailwind classes for a rating badge. */
export function ratingBadgeClass(rating: string): string {
  const r = (rating || "").trim();
  return isRating(r) ? RATING_BADGE[r] : "bg-neutral-800 border-neutral-700 text-neutral-100";
}
