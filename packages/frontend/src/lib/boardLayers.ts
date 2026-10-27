/**
 * What the composer's other layers already say, as prompt-board layers. A
 * character's tags strike out there as they do in their card, for this
 * batch only: the recipe itself changes in its Edit dialog.
 */
import type { CharacterEntry } from "./character";
import { displayName } from "./character";
import { setOutfitPick, strikeCharacter, toggleIdentityOff, undoStrike } from "./composerEdits";
import type { PromptPart, Recipe } from "./generate";
import type { GenerateForm } from "./generateForm";
import { toggleWorn } from "./outfit";
import type { BoardLayer } from "./promptBoard";

/** A prompt part's layer, named on the prompt board. */
const LAYER_LABEL: Record<string, string> = { prefix: "Prefix", style: "Style", text: "Text", preset: "Preset" };

/** The board's layers: the text parts other than the Prompt, then each
 * loaded character with their identity and what they wear. `edit` applies
 * a form update (setForm); `form` is the form as rendered. */
export function boardLayersOf(
  positive: readonly PromptPart[],
  recipes: readonly (Recipe | undefined)[],
  everyone: readonly CharacterEntry[] | undefined,
  form: GenerateForm,
  edit: (fn: (f: GenerateForm) => GenerateForm) => void,
): BoardLayer[] {
  return [
    ...positive.flatMap((p, i) =>
      p.kind === "text" && p.role !== "prompt" && p.text?.trim()
        ? [{ key: `part:${i}`, label: p.label || LAYER_LABEL[p.role ?? ""] || "Layer", text: p.text }]
        : [],
    ),
    ...recipes.flatMap((r) => {
      if (!r) return [];
      const entry = everyone?.find((c) => c.tag === r.tag);
      const pick = form.outfits[r.tag];
      return [
        {
          key: `character:${r.tag}`,
          label: displayName(entry ?? { tag: r.tag }).name,
          character: entry,
          onStrike: (tags: string[]) => {
            const was = form.outfits[r.tag];
            edit((f) => strikeCharacter(f, r, tags));
            return () => edit((f) => undoStrike(f, r, tags, was));
          },
          tags: [
            { tag: r.tag, self: true },
            ...r.identity
              .filter((c) => !c.dropped)
              .map((c) => ({
                tag: c.tag,
                dropped: !!form.identityOff[r.tag]?.includes(c.tag),
                onToggle: () => edit((f) => toggleIdentityOff(f, r.tag, c.tag)),
              })),
            ...(pick?.tags ?? []).map((t) => ({
              tag: t,
              dropped: pick!.dropped.includes(t),
              onToggle: () => edit((f) => setOutfitPick(f, r.tag, toggleWorn(pick!, t))),
            })),
          ],
        },
      ];
    }),
  ];
}
