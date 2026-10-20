import { useSyncExternalStore } from "react";

/**
 * How tags are marked in tag lists (lib/tagColour.ts): hair and eye tags
 * outlined in their colour, and every tag tinted by its facet. A view
 * preference, kept on this device; changing it in Settings updates every
 * open list at once.
 */
export type TagMarks = { outlines: boolean; tints: boolean };

const KEY = "tags:marks";
export const TAG_MARKS_DEFAULT: TagMarks = { outlines: true, tints: true };

let current: TagMarks = read();
const listeners = new Set<() => void>();

function read(): TagMarks {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return TAG_MARKS_DEFAULT;
    const v = JSON.parse(raw) as Partial<TagMarks>;
    return {
      outlines: typeof v.outlines === "boolean" ? v.outlines : TAG_MARKS_DEFAULT.outlines,
      tints: typeof v.tints === "boolean" ? v.tints : TAG_MARKS_DEFAULT.tints,
    };
  } catch {
    // Private mode / storage disabled: the defaults.
    return TAG_MARKS_DEFAULT;
  }
}

export function setTagMarks(patch: Partial<TagMarks>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Non-fatal; the preference just won't survive a reload.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTagMarks(): TagMarks {
  return useSyncExternalStore(subscribe, () => current);
}
