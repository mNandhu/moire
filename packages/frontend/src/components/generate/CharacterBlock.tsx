import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, RotateCcw, Undo2, UserRound, X } from "lucide-react";
import { Badge } from "../ui";
import { Picker, type PickerOption } from "../ui/Picker";
import { CharacterAvatar } from "../CharacterAvatar";
import { useCharacters } from "../ImageCharacters";
import { cn } from "../../lib/cn";
import { characterHref, displayName, type CharacterEntry } from "../../lib/character";
import { displayWord } from "../../lib/compose";
import { putRecipe, recipeKey, useRecipe, type Recipe, type RecipePatch } from "../../lib/generate";
import { toggleDropped } from "../../lib/recipe";
import { FieldLabel, stemOf } from "./RunControls";

const NO_LORA = "\u0000none";

function characterOptions(list: readonly CharacterEntry[]): PickerOption[] {
  return list.map((c) => {
    const { name, series } = displayName(c);
    return {
      value: c.tag,
      label: name,
      detail: series ?? undefined,
      hint: c.count.toLocaleString(),
      keywords: [c.tag, ...c.aliases].join(" "),
      icon: <CharacterAvatar src={c.thumb_url} face={c.face} focus={c.focus} aspect={c.aspect} className="h-6 w-6" />,
    };
  });
}

/** The character picker: avatars, search over every name, image counts. */
function CharacterPicker({
  value,
  onChange,
  trigger,
}: {
  value: string | null;
  onChange: (tag: string) => void;
  trigger?: (p: { open: boolean; label: string | null }) => React.ReactNode;
}) {
  const { data } = useCharacters();
  const opts = useMemo(() => characterOptions(data ?? []), [data]);
  return (
    <Picker
      aria-label="Character"
      value={value ?? ""}
      options={opts}
      onChange={onChange}
      placeholder="Pick a character"
      searchable
      trigger={trigger}
      align={trigger ? "right" : "left"}
      className={trigger ? undefined : "w-full"}
    />
  );
}

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

  return (
    <div>
      <FieldLabel>
        <span title="Changes with the character">Character LoRA</span>
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div title={why} className={cn("min-w-[12rem] max-w-full", invalid && "rounded-lg ring-1 ring-red-700")}>
          <Picker
            aria-label="Character LoRA"
            value={value}
            options={opts}
            onChange={(v) => onPatch({ lora: v === NO_LORA ? "" : v, strength: null })}
            searchable
            className="w-full"
          />
        </div>
        {lora && (
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
            <span title="Left out until it's installed in ComfyUI">
              <Badge tone="warning">Not installed</Badge>
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

/**
 * The Character block: the picked character, their identity tags (drop one to
 * leave it out of this recipe, kept for next time) and their LoRA. Edits are
 * the recipe's, stored on the server; the batch records what was sent.
 */
export function CharacterBlock({
  value,
  onChange,
  installedLoras,
  rejectedLoras,
}: {
  value: string | null;
  onChange: (tag: string | null) => void;
  installedLoras: readonly string[];
  rejectedLoras: ReadonlySet<string>;
}) {
  const qc = useQueryClient();
  const { data: everyone } = useCharacters();
  const entry = useMemo(() => everyone?.find((c) => c.tag === value) ?? null, [everyone, value]);
  const { data: recipe, isError } = useRecipe(value);
  const patch = useMutation({
    mutationFn: (p: RecipePatch) => putRecipe(value!, p),
    onSuccess: (r) => qc.setQueryData(recipeKey(r.tag), r),
  });

  if (!value) {
    return (
      <div>
        <FieldLabel>Character</FieldLabel>
        <CharacterPicker value={null} onChange={onChange} />
      </div>
    );
  }

  const { name, series } = displayName(entry ?? { tag: value });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-full text-xs font-medium text-muted">Character</div>
        {entry ? (
          <CharacterAvatar
            src={entry.thumb_url}
            face={entry.face}
            focus={entry.focus}
            aspect={entry.aspect}
            className="h-12 w-12 ring-1 ring-line"
          />
        ) : (
          <div className="grid h-12 w-12 place-items-center rounded-full bg-raised text-faint">
            <UserRound size={20} />
          </div>
        )}
        <div className="min-w-0">
          <Link to={characterHref(value)} className="block truncate text-base font-semibold text-neutral-50 hover:underline">
            {name}
          </Link>
          <div className="text-xs text-muted">
            {series && (
              <>
                {series} <span className="text-line-strong">|</span>{" "}
              </>
            )}
            {(recipe?.count ?? entry?.count ?? 0).toLocaleString()} images
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <CharacterPicker
            value={value}
            onChange={onChange}
            trigger={() => (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 text-xs text-neutral-200 hover:border-line-strong">
                Change character
                <ChevronDown size={13} />
              </span>
            )}
          />
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Remove character"
            title="Remove character"
            className="rounded-lg p-1.5 text-muted hover:bg-line hover:text-neutral-100"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {isError && <div className="text-xs text-red-300">Not in the library any more</div>}
      {recipe && (
        <>
          <div>
            <FieldLabel>Identity</FieldLabel>
            <div className="flex flex-wrap gap-1.5">
              <span
                className="inline-flex items-center rounded-md border border-brand-700 bg-brand-900/30 px-2 py-0.5 text-sm text-brand-100"
                title={recipe.tag}
              >
                {displayWord(recipe.tag)}
              </span>
              {recipe.identity.map((c) => (
                <span
                  key={c.tag}
                  title={c.dropped ? "Dropped from this recipe" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border pl-2 pr-1 py-0.5 text-sm",
                    c.dropped ? "border-line/60 text-faint line-through" : "border-line bg-raised text-neutral-100",
                  )}
                >
                  {displayWord(c.tag)}
                  <button
                    type="button"
                    onClick={() => patch.mutate({ dropped: toggleDropped(recipe, c.tag) })}
                    aria-label={`${c.dropped ? "Restore" : "Drop"} ${displayWord(c.tag)}`}
                    className="rounded p-0.5 text-muted no-underline hover:bg-line hover:text-neutral-100"
                  >
                    {c.dropped ? <Undo2 size={13} /> : <X size={13} />}
                  </button>
                </span>
              ))}
            </div>
          </div>
          <LoraControl
            recipe={recipe}
            installed={installedLoras}
            invalid={!!recipe.lora?.file && rejectedLoras.has(recipe.lora.file)}
            onPatch={(p) => patch.mutate(p)}
            label={name}
          />
        </>
      )}
    </div>
  );
}
