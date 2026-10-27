/**
 * Every write the UI can make to Images: one Image's rating, score,
 * quarantine, purge and tags, and manual tags on many at once. The backend
 * counterpart is services/image_tags.py, the single owner of per-image
 * writes. Tag and character state lives in lib/tagMutations.ts.
 */

import { apiJson } from "./api";

const post = <T>(url: string, body?: unknown) => apiJson<T>(url, "POST", body);

const forImage = (id: string, suffix: string) =>
  `/api/v1/images/${encodeURIComponent(id)}/${suffix}`;

// --- Scalars ------------------------------------------------------------------

export function setRating(id: string, rating: string): Promise<unknown> {
  return post(forImage(id, "rating"), { rating });
}

export function setScore(id: string, score: number): Promise<unknown> {
  return post(forImage(id, "score"), { score });
}

export function setQuarantine(
  id: string,
  quarantined: boolean,
): Promise<unknown> {
  return post(forImage(id, "quarantine"), { quarantined });
}

/** Irreversible: deletes the original file from disk as well as all records. */
export function purgeImage(id: string): Promise<unknown> {
  return post(forImage(id, "purge"), { confirm: true });
}

// --- Tags ---------------------------------------------------------------------

/** Apply manual tags (the backend adds the `manual:` prefix). */
export function applyTags(id: string, tags: string[]): Promise<unknown> {
  return post(`/api/v1/tags/apply/${encodeURIComponent(id)}`, tags);
}

export function removeTags(id: string, tags: string[]): Promise<unknown> {
  return post(`/api/v1/tags/remove/${encodeURIComponent(id)}`, tags);
}

/** Add/remove manual tags (bare names) on many images in one transaction. */
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
