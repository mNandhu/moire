import type { ImageDoc } from "./imageFilter";

/**
 * The rating to display for an image: the explicit `rating` if set, else the
 * highest-scoring label from the AI rating map, else "-". Pure precedence logic
 * lifted out of ImageView so it has a test surface.
 */
export function pickRating(doc: ImageDoc | null | undefined): string {
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

/** Tailwind classes for a rating badge. */
export function ratingBadgeClass(rating: string): string {
  switch (rating) {
    case "general":
    case "safe":
      return "bg-emerald-900/30 border-emerald-800 text-emerald-100";
    case "sensitive":
      return "bg-amber-900/30 border-amber-800 text-amber-100";
    case "questionable":
      return "bg-orange-900/30 border-orange-800 text-orange-100";
    case "explicit":
      return "bg-red-900/30 border-red-800 text-red-100";
    default:
      return "bg-neutral-800 border-neutral-700 text-neutral-100";
  }
}

/**
 * Tailwind background for the small rating dot drawn on a gallery tile. A
 * badge with text is too heavy at thumbnail scale, so the tile shows colour
 * only and puts the label in the tooltip; the palette matches
 * `ratingBadgeClass` so the two readings of the same field agree.
 *
 * Returns null for ratings that aren't worth marking ("general" is the
 * unremarkable default, "-" means unrated). The tile draws nothing.
 */
export function ratingDotClass(rating: string | null | undefined): string | null {
  switch ((rating || "").trim()) {
    case "sensitive":
      return "bg-amber-400";
    case "questionable":
      return "bg-orange-400";
    case "explicit":
      return "bg-red-400";
    default:
      return null;
  }
}
