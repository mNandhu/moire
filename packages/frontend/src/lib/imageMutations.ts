/**
 * Every per-image mutation the UI can issue, in one place.
 *
 * These were split three ways: score/quarantine/purge lived in lib/gen (they
 * are curation, not generation metadata), while rating, apply-tags and
 * set-tag-thumbnail were hand-rolled `fetch` + JSON.stringify inside ImageView,
 * bypassing the shared client entirely. "How does the UI mutate an Image" had
 * no single answer. You grepped.
 *
 * The backend counterpart is services/image_tags.py, the single owner of
 * per-image writes; this is its mirror on the client.
 */

import { api } from "./api";
import type { CharacterPatch } from "./character";

function post<T>(url: string, body?: unknown): Promise<T> {
  return api<T>(url, {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}

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

/** Pin this image as the mosaic thumbnail for a tag. `tag` is the raw stored
 * form, prefix included. */
/** Pin a tag's cover. Keyed by the tag's name, so it shows for every source. */
export function setTagThumbnail(tag: string, imageId: string): Promise<unknown> {
  return post(`/api/v1/tags/thumbnail/${encodeURIComponent(tag)}`, {
    image_id: imageId,
  });
}

/** Unpin a tag's cover; its mosaic goes back to picking images itself. */
export function clearTagThumbnail(tag: string): Promise<unknown> {
  return api(`/api/v1/tags/thumbnail/${encodeURIComponent(tag)}`, { method: "DELETE" });
}

/** Set what the user decides for a character (any of its names); "" clears. */
export function updateCharacter(tag: string, patch: CharacterPatch): Promise<unknown> {
  return api(`/api/v1/tags/character?${new URLSearchParams({ tag })}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** Make a character by hand; returns its stored settings (with its tag). */
export function createCharacter(body: { tag: string; name?: string; series?: string; color?: string }) {
  return api<{ tag: string }>(`/api/v1/tags/characters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Forget a character made by hand (only while no image has it). */
export function deleteCharacter(tag: string): Promise<unknown> {
  return api(`/api/v1/tags/character?${new URLSearchParams({ tag })}`, { method: "DELETE" });
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
