import type { PickerOption } from "../components/ui";
import type { GeneratorSetup, GeneratorSlots, SeedGroup, SlotPath, TextInput } from "./generate";

export type Side = "positive" | "negative";

const samePath = (a: SlotPath | undefined | null, b: SlotPath | undefined | null) =>
  !!a && !!b && a[0] === b[0] && a[1] === b[1];

export const pathKey = (p: SlotPath) => `${p[0]}\u0000${p[1]}`;

/** "#14 text": a node id and the input on it. */
export const pathLabel = (p: SlotPath) => `#${p[0]} ${p[1]}`;

/** The text input a slot points at, if the picker lists it. */
export function inputAt(setup: GeneratorSetup, path: SlotPath | undefined): TextInput | undefined {
  return path ? setup.text_inputs.find((t) => samePath(t.path, path)) : undefined;
}

/**
 * The node picker's options for one prompt: what reaches that side of the
 * sampler first, then the rest, dimmed with why. With no sampler found
 * nothing is known to reach anything, so all are listed plainly.
 */
export function pickerOptions(setup: GeneratorSetup, side: Side): PickerOption[] {
  const other: Side = side === "positive" ? "negative" : "positive";
  const reaches = (t: TextInput) => t.reaches === side || t.reaches === "both";
  const why = (t: TextInput) =>
    t.reaches === other ? `Feeds the ${other}` : setup.found.sampler ? "Not used by the sampler" : undefined;
  const option = (t: TextInput, dim: boolean): PickerOption => ({
    value: pathKey(t.path),
    label: t.title,
    detail: t.replaces_link ? `${pathLabel(t.path)}, joined` : pathLabel(t.path),
    hint: dim ? why(t) : undefined,
    dim,
    keywords: `${t.class_type} ${t.text ?? ""}`,
    group: !setup.found.sampler ? "Text inputs" : dim ? "Other text inputs" : `Reach the sampler's ${side}`,
  });
  if (!setup.found.sampler) return setup.text_inputs.map((t) => option(t, false));
  return [
    ...setup.text_inputs.filter(reaches).map((t) => option(t, false)),
    ...setup.text_inputs.filter((t) => !reaches(t)).map((t) => option(t, true)),
  ];
}

/** Slots with ``side`` written at ``input``: a joined text's encoder input is
 * overwritten (``replace_links``), any other input is not. */
export function pickPrompt(slots: GeneratorSlots, side: Side, input: TextInput): GeneratorSlots {
  const links = new Set(slots.replace_links ?? []);
  if (input.replaces_link) links.add(side);
  else links.delete(side);
  return { ...slots, [side]: input.path, replace_links: [...links] };
}

/** Whether every input of a seed group is ticked (Moiré writes it). */
export function groupTicked(slots: GeneratorSlots, group: SeedGroup): boolean {
  const on = new Set((slots.seeds ?? []).map(pathKey));
  return group.inputs.every((i) => on.has(pathKey(i.path)));
}

export function tickGroup(slots: GeneratorSlots, group: SeedGroup, on: boolean): GeneratorSlots {
  const paths = group.inputs.map((i) => i.path);
  const keys = new Set(paths.map(pathKey));
  const rest = (slots.seeds ?? []).filter((p) => !keys.has(pathKey(p)));
  return { ...slots, seeds: on ? [...rest, ...paths] : rest };
}

export type CheckItem = { label: string; ok: boolean; note?: boolean };

/** "Before it can be used": what the slots have, and what's still missing.
 * ``note`` items don't block saving. */
export function checklist(setup: GeneratorSetup, slots: GeneratorSlots): CheckItem[] {
  const items: CheckItem[] = [
    slots.positive
      ? { label: "Positive prompt found", ok: true }
      : { label: "Positive prompt: choose a node", ok: false },
    slots.negative
      ? { label: "Negative prompt found", ok: true }
      : { label: "Negative prompt: choose a node", ok: false },
    setup.outputs.some((o) => o.saves)
      ? { label: "Saves into the ComfyUI output library", ok: true }
      : { label: "No Save Image node: add one in ComfyUI", ok: false },
    slots.lora_model
      ? { label: "LoRA insertion point found", ok: true }
      : { label: "No LoRA insertion point: LoRAs are off", ok: true, note: true },
  ];
  if (!slots.seeds?.length) items.push({ label: "No seed is randomized: every image repeats", ok: true, note: true });
  for (const img of setup.input_images) {
    items.push({ label: `Uses an input image: ${img.title} #${img.node}`, ok: true, note: true });
  }
  return items;
}

/** Whether the checklist lets the Generator be saved. */
export const canSave = (items: readonly CheckItem[]) => items.every((i) => i.ok);

/** The setup page's name for a new workflow: the family's, the imported
 * file it matches, the uploaded file's, its Save Image prefix, or a plain
 * fallback. */
export function defaultName(setup: GeneratorSetup): string {
  const s = setup.source;
  const file = s.kind === "image" ? (s.family_name ?? s.file_name) : s.filename;
  if (file) return file.replace(/\.json$/i, "");
  const prefix = setup.outputs.find((o) => o.saves && o.prefix)?.prefix;
  if (prefix) return prefix.split("/").filter(Boolean).pop() ?? prefix;
  return "Workflow";
}
