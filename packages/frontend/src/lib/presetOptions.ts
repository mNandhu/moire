/**
 * The options of a preset picker (prompt presets and a LoRA's presets
 * share it): None, the presets, a faded row for a preset that was deleted
 * while a layer still points at it, and New. Pure.
 */
import type { PickerOption } from "../components/ui/Picker";

export const NONE = "\u0000none";
export const NEW = "\u0000new";

export type PresetLike = { _id: string; name: string; text: string };

/** The selected preset's id is not among `presets` once they are loaded. */
export function isDeletedPreset(presets: readonly PresetLike[], selected: string | undefined, loaded: boolean): boolean {
  return !!selected && loaded && !presets.some((p) => p._id === selected);
}

export function presetOptions(
  presets: readonly PresetLike[],
  selected: string | undefined,
  loaded: boolean,
  { noneDetail, showText }: { noneDetail?: string; showText?: boolean } = {},
): PickerOption[] {
  return [
    { value: NONE, label: "None", detail: noneDetail },
    ...presets.map((p) => ({ value: p._id, label: p.name, detail: showText ? p.text : undefined, keywords: p.text })),
    ...(isDeletedPreset(presets, selected, loaded) ? [{ value: selected!, label: "Deleted preset", dim: true }] : []),
    { value: NEW, label: "New preset" },
  ];
}

/** What picking `value` means: no preset, a new one, or this one (undefined when it is gone). */
export function presetChoice<P extends PresetLike>(presets: readonly P[], value: string): { none: true } | { create: true } | { preset: P } | undefined {
  if (value === NONE) return { none: true };
  if (value === NEW) return { create: true };
  const preset = presets.find((p) => p._id === value);
  return preset ? { preset } : undefined;
}
