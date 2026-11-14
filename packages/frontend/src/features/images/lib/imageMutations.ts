/**
 * Every write the UI can make to Images: one Image's rating, score,
 * quarantine, purge and tags, and manual tags on many at once. The backend
 * counterpart is services/tags/image_tags.py, the single owner of per-image
 * writes. Tag and character state lives in features/tags/lib/tagMutations.ts.
 */

import { apiJson } from "@/lib/api";
import { imageUrl } from "@/lib/media";

const post = <T>(url: string, body?: unknown) => apiJson<T>(url, "POST", body);


// --- Scalars ------------------------------------------------------------------

/** Resolves to the rating now stored: Unrated ("-") hands it back to the AI
 * tagger, so the answer is its pick, which may not be "-". */
export async function setRating(id: string, rating: string): Promise<string> {
  const res = await post<{ rating?: string } | null>(imageUrl(id, "rating"), { rating });
  return res?.rating ?? rating;
}

export function setScore(id: string, score: number): Promise<unknown> {
  return post(imageUrl(id, "score"), { score });
}

export function setQuarantine(
  id: string,
  quarantined: boolean,
): Promise<unknown> {
  return post(imageUrl(id, "quarantine"), { quarantined });
}

// --- Tags ---------------------------------------------------------------------

/** Apply manual tags (the backend adds the `manual:` prefix). */
export function applyTags(id: string, tags: string[]): Promise<unknown> {
  return post(`/api/v1/tags/apply/${encodeURIComponent(id)}`, tags);
}

/** Add/remove manual tags (bare names) on many images (applied in chunks). */
export function bulkManualTags(
  ids: string[],
  edit: { add?: string[]; remove?: string[] },
): Promise<{ matched: number; modified: number }> {
  return post("/api/v1/tags/bulk", {
    image_ids: ids,
    add: edit.add ?? [],
    remove: edit.remove ?? [],
  });
}
