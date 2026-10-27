/**
 * Writes to a tag's or a character's own state: its pinned cover and cover
 * focus, and the character settings the user decides. Per-image writes live
 * in lib/imageMutations.ts.
 */

import { apiJson } from "./api";
import type { CharacterPatch } from "./character";

const send = <T>(method: string, url: string, body?: unknown) => apiJson<T>(url, method, body);

const characterUrl = (tag: string) => `/api/v1/tags/character?${new URLSearchParams({ tag })}`;

/** Pin a tag's cover. Keyed by the tag's name, so it shows for every source. */
export function setTagThumbnail(tag: string, imageId: string): Promise<unknown> {
  return send("POST", `/api/v1/tags/thumbnail/${encodeURIComponent(tag)}`, { image_id: imageId });
}

/** Unpin a tag's cover; its mosaic goes back to picking images itself. */
export function clearTagThumbnail(tag: string): Promise<unknown> {
  return send("DELETE", `/api/v1/tags/thumbnail/${encodeURIComponent(tag)}`);
}

/** Centre a plain tag's cover on a point (0..1); null puts it back. */
export function setTagFocus(tag: string, focus: readonly [number, number] | null): Promise<unknown> {
  return send("PUT", `/api/v1/tags/focus?${new URLSearchParams({ tag })}`, {
    focus_x: focus ? focus[0] : "",
    focus_y: focus ? focus[1] : "",
  });
}

/** Set what the user decides for a character (any of its names); "" clears. */
export function updateCharacter(tag: string, patch: CharacterPatch): Promise<unknown> {
  return send("PATCH", characterUrl(tag), patch);
}

/** Make a character by hand; returns its stored settings (with its tag). */
export function createCharacter(body: { tag: string; name?: string; series?: string; color?: string }) {
  return send<{ tag: string }>("POST", "/api/v1/tags/characters", body);
}

/** Forget a character made by hand (only while no image has it). */
export function deleteCharacter(tag: string): Promise<unknown> {
  return send("DELETE", characterUrl(tag));
}
