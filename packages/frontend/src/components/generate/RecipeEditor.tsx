import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, RotateCcw } from "lucide-react";
import { Badge } from "../ui";
import { Picker, type PickerOption } from "../ui/Picker";
import { cn } from "../../lib/cn";
import { fewImagesNote } from "../../lib/character";
import { useChipBorderStyle } from "../../hooks/useTagMarks";
import { displayWord } from "../../lib/compose";
import { putRecipe, recipeKey, type Gender, type Recipe, type RecipePatch } from "../../lib/generate";
import { toggleDropped } from "../../lib/recipe";
import { FieldLabel } from "./fields";
import { stemOf } from "../../lib/modelNames";
import { TagAddInput } from "../TagAddInput";
import { TagPill } from "./TagPill";

const NO_LORA = "\u0000none";

/** Character LoRA: the ones used with this character first, then every installed one. */
function LoraControl({
  recipe,
  installed,
  invalid,
  onPatch,
  label,
}: {
  recipe: Recipe;
  installed: readonly string[];
  invalid: boolean;
  onPatch: (p: RecipePatch) => void;
  label: string;
}) {
  const lora = recipe.lora;
  const [strength, setStrength] = useState(lora?.strength ?? 1);
  useEffect(() => setStrength(lora?.strength ?? 1), [lora?.strength]);
  const commit = () => {
    if (lora && strength !== lora.strength) onPatch({ strength });
  };

  const opts: PickerOption[] = useMemo(() => {
    const used = recipe.candidates.map((c) => ({
      value: c.file ?? c.stem,
      label: c.stem,
      hint: c.images.toLocaleString(),
      dim: !c.file,
      group: `Used with ${label}`,
    }));
    const taken = new Set(recipe.candidates.map((c) => c.stem));
    const rest = installed
      .filter((n) => !taken.has(stemOf(n)))
      .map((n) => ({ value: n, label: stemOf(n), detail: n.includes("/") ? n : undefined, group: "Installed" }));
    return [{ value: NO_LORA, label: "No LoRA" }, ...used, ...rest];
  }, [recipe.candidates, installed, label]);

  const value = lora ? (lora.file ?? lora.stem) : NO_LORA;
  const why = lora?.images
    ? `Used on ${lora.images.toLocaleString()} of ${label}'s images`
    : recipe.lora_edited
      ? "Picked by you"
      : undefined;

  const unused = !!lora && !lora.file;
  return (
    <div>
      <FieldLabel>
        <span title="Changes with the character">Character LoRA</span>
      </FieldLabel>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2",
          unused && "rounded-lg border border-dashed border-amber-700/70 bg-amber-950/20 px-2.5 py-2",
        )}
      >
        <div
          title={why}
          className={cn(
            "min-w-[12rem] max-w-full",
            invalid && "rounded-lg ring-1 ring-red-700",
            unused && "opacity-60 [&_button>span]:line-through",
          )}
        >
          <Picker
            aria-label="Character LoRA"
            value={value}
            options={opts}
            onChange={(v) => onPatch({ lora: v === NO_LORA ? "" : v, strength: null })}
            searchable
            className="w-full"
          />
        </div>
        {lora && !unused && (
          <label className="flex items-center gap-2.5 text-xs text-muted">
            Strength
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={strength}
              onChange={(e) => setStrength(Number(e.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
              className="w-32 accent-brand-500"
            />
            <span className="w-8 font-mono text-neutral-100 tabular-nums">{strength.toFixed(2)}</span>
          </label>
        )}
        {lora &&
          (lora.file ? (
            <Badge tone="success">
              <Check size={12} />
              Installed
            </Badge>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-200"
              title="This ComfyUI doesn't have this LoRA, so it is left out of the prompt. Install it, then Refresh models in Settings, or pick another."
            >
              <Ban size={14} />
              Not installed, not used
            </span>
          ))}
        {(recipe.lora_edited || recipe.strength_edited) && (
          <button
            type="button"
            onClick={() => onPatch({ lora: null, strength: null })}
            title="Back to the LoRA picked from the library"
            aria-label="Reset character LoRA"
            className="rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Saves a change to a character's recipe and puts the result in the cache. */
export function useRecipePatch(tag: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: RecipePatch) => putRecipe(tag, p),
    onSuccess: (r) => qc.setQueryData(recipeKey(r.tag), r),
  });
}

const GENDERS: { value: Gender; label: string }[] = [
  { value: "girl", label: "Girl" },
  { value: "boy", label: "Boy" },
  { value: "other", label: "Other" },
];

/** Girl / boy / other, for the count tags Generate writes (1girl, 1boy...).
 * Picking the one already set by hand goes back to what their images say;
 * amber while it's unknown. */
export function GenderPick({ recipe, onPick, small }: { recipe: Recipe; onPick: (g: Gender | null) => void; small?: boolean }) {
  const unknown = recipe.gender == null;
  const read = recipe.gender_read ? GENDERS.find((g) => g.value === recipe.gender_read)?.label.toLowerCase() : null;
  return (
    <div
      role="radiogroup"
      aria-label="Gender"
      title={
        recipe.gender_set
          ? `Set by you${read ? `; their images say ${read}` : ""}`
          : unknown
            ? "Their images don't say. Pick one so the prompt gets the right count tags"
            : "Read from their images"
      }
      className={cn(
        "inline-flex shrink-0 gap-0.5 rounded-lg border p-0.5",
        unknown ? "border-dashed border-amber-500/60 bg-amber-500/5" : "border-line bg-canvas",
      )}
    >
      {GENDERS.map((g) => {
        const on = recipe.gender === g.value;
        return (
          <button
            key={g.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(on && recipe.gender_set ? null : g.value)}
            className={cn(
              "rounded-md font-medium transition-colors",
              small ? "px-1.5 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
              on
                ? recipe.gender_set
                  ? "bg-brand-600 text-white"
                  : "bg-line text-neutral-100"
                : unknown
                  ? "text-amber-200 hover:bg-amber-500/10"
                  : "text-muted hover:bg-line hover:text-neutral-100",
            )}
          >
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A recipe's editable parts: identity tags (drop a computed one, add your
 * own) and the character LoRA. Changes are saved to the recipe at once, so
 * the composer and the character page show the same thing. With `off`
 * (Generate's card), a tag's X strikes it for this batch only, and tags
 * are added in the Edit dialog instead.
 */
export function RecipeEditor({
  recipe,
  label,
  installedLoras,
  rejectedLoras,
  off,
}: {
  recipe: Recipe;
  label: string;
  installedLoras: readonly string[];
  rejectedLoras?: ReadonlySet<string>;
  off?: { tags: readonly string[]; toggle: (tag: string) => void };
}) {
  const chipBorderStyle = useChipBorderStyle();
  const patch = useRecipePatch(recipe.tag);
  const added = recipe.identity.filter((c) => c.added).map((c) => c.tag);
  // Only about computed tags: the ones you added aren't a guess.
  const note = recipe.identity.some((c) => !c.added) ? fewImagesNote(recipe.identity_images) : null;
  const taken = useMemo(() => new Set([recipe.tag, ...recipe.identity.map((c) => c.tag)]), [recipe]);
  return (
    <>
      <div>
        <FieldLabel>Gender</FieldLabel>
        <GenderPick recipe={recipe} onPick={(gender) => patch.mutate({ gender })} />
      </div>
      <div>
        <FieldLabel>Identity</FieldLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center rounded-md border border-brand-700 bg-brand-900/30 px-2 py-0.5 text-sm text-brand-100"
            title={recipe.tag}
          >
            {displayWord(recipe.tag)}
          </span>
          {off
            ? recipe.identity
                .filter((c) => !c.dropped)
                .map((c) => {
                  const struck = off.tags.includes(c.tag);
                  return (
                    <TagPill
                      key={c.tag}
                      tag={c.tag}
                      struck={struck}
                      title={struck ? "Left out of this batch" : undefined}
                      style={chipBorderStyle(c.tag)}
                      onToggle={() => off.toggle(c.tag)}
                      actionLabel={`${struck ? "Bring back" : "Leave out"} ${displayWord(c.tag)}`}
                      actionTitle={struck ? "Bring back" : "Leave out of this batch"}
                    />
                  );
                })
            : recipe.identity.map((c) => (
                <TagPill
                  key={c.tag}
                  tag={c.tag}
                  struck={c.dropped}
                  title={c.dropped ? "Dropped from this recipe" : c.added ? "Added by you" : undefined}
                  style={chipBorderStyle(c.tag)}
                  className={c.added && !c.dropped ? "border-brand-800" : undefined}
                  onToggle={() =>
                    patch.mutate(
                      c.added ? { added: added.filter((a) => a !== c.tag) } : { dropped: toggleDropped(recipe, c.tag) },
                    )
                  }
                  actionLabel={`${c.dropped ? "Restore" : c.added ? "Remove" : "Drop"} ${displayWord(c.tag)}`}
                />
              ))}
          {!off && <TagAddInput ariaLabel="Add identity tag" taken={taken} onAdd={(tag) => !taken.has(tag) && patch.mutate({ added: [...added, tag] })} />}
        </div>
        {note && <p className="mt-1.5 text-xs text-faint">{note}</p>}
      </div>
      <LoraControl
        recipe={recipe}
        installed={installedLoras}
        invalid={!!recipe.lora?.file && !!rejectedLoras?.has(recipe.lora.file)}
        onPatch={(p) => patch.mutate(p)}
        label={label}
      />
    </>
  );
}
