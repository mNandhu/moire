import { readLocalPref, writeLocalPref } from "../lib/localPref";
import { useLocalPref } from "./useLocalPref";
import { chipBorderStyle } from "../lib/tagColour";

/**
 * How tags are marked in tag lists (lib/tagColour.ts): hair and eye tags
 * outlined in their colour, and every tag tinted by its facet. A view
 * preference, kept on this device; changing it in Settings updates every
 * open list at once, in other tabs too.
 */
export type TagMarks = { outlines: boolean; tints: boolean };

const KEY = "tags:marks";
export const TAG_MARKS_DEFAULT: TagMarks = { outlines: true, tints: true };

function parseMarks(raw: string): TagMarks {
  const v = JSON.parse(raw) as Partial<TagMarks>;
  return {
    outlines: typeof v.outlines === "boolean" ? v.outlines : TAG_MARKS_DEFAULT.outlines,
    tints: typeof v.tints === "boolean" ? v.tints : TAG_MARKS_DEFAULT.tints,
  };
}

function current(): TagMarks {
  const raw = readLocalPref(KEY);
  try {
    return raw ? parseMarks(raw) : TAG_MARKS_DEFAULT;
  } catch {
    return TAG_MARKS_DEFAULT;
  }
}

export function setTagMarks(patch: Partial<TagMarks>) {
  writeLocalPref(KEY, JSON.stringify({ ...current(), ...patch }));
}

export function useTagMarks(): TagMarks {
  return useLocalPref(KEY, TAG_MARKS_DEFAULT, { parse: parseMarks })[0];
}

/** {@link chipBorderStyle} as Settings has it: nothing with outlines off. */
export function useChipBorderStyle(): typeof chipBorderStyle {
  const { outlines } = useTagMarks();
  return outlines ? chipBorderStyle : () => undefined;
}
