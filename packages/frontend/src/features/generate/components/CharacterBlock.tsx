import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, ArrowUpRight, Ban, CircleAlert, Pencil, UserRound, X } from "lucide-react";
import { Card } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { ButtonLink } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { CharacterAvatar } from "@/features/characters/components/CharacterAvatar";
import { CharacterPicker } from "@/features/characters/components/CharacterPicker";
import { useCharacters } from "@/features/characters/lib/queries";
import { cn } from "@/lib/cn";
import { characterHref, displayName } from "@/features/characters/lib/character";
import { displayWord } from "@/features/generate/lib/compose";
import { recipeStuck, useRecipe } from "@/features/generate/lib/generate";
import { isNotFound } from "@/lib/api";
import { characterTags } from "@/features/generate/lib/recipe";
import { tagRepeats } from "@/features/generate/lib/prompt/promptRepeats";
import { PromptRepeats } from "./PromptRepeats";
import { FieldLabel } from "./fields";
import { ExpandButton } from "./Layers";
import { GenderPick, RecipeEditor, useRecipePatch } from "./RecipeEditor";
import { replaceCharacter } from "@/features/generate/lib/generateForm";
import { MAX_CHARACTERS } from "@/features/generate/lib/generationLimits";
import { OutfitChips, OutfitPicker } from "@/features/characters/components/outfits/Outfit";
import { useCharacterOutfits } from "@/features/characters/hooks/useOutfitData";
import { toggleWorn, wornTags, type OutfitPick, type Outfits } from "@/features/characters/lib/outfit";
import { useAttireGroups } from "@/features/tags/lib/queries";

/** An amber dashed badge on the Character line: something left out or wrong. */
const WARN_BADGE =
  "inline-flex items-center gap-1.5 rounded-md border border-dashed border-amber-700/70 bg-amber-950/20 px-1.5 py-0.5 text-xs text-amber-200";

/**
 * The Character layer: one line (avatar, name, the identity tags it adds, its
 * LoRA) that unfolds the recipe editor below it; the pencil opens
 * just the recipe. With no character, just the picker.
 */
function CharacterRow({
  value,
  onChange,
  installedLoras,
  rejectedLoras,
  open = false,
  onPickerClose,
  taken,
  outfit,
  onOutfit,
  prompt,
  onPrompt,
  off,
  loraSwitch,
}: {
  value: string | null;
  onChange: (tag: string | null) => void;
  /** Identity tags struck for this batch, and the toggle. */
  off?: { tags: readonly string[]; toggle: (tag: string) => void };
  /** Its LoRA switched off for this batch, and the toggle. */
  loraSwitch?: { off: boolean; toggle: () => void };
  installedLoras: readonly string[];
  rejectedLoras: ReadonlySet<string>;
  taken?: readonly string[];
  /** What they wear in this batch. */
  outfit?: OutfitPick;
  onOutfit?: (pick: OutfitPick | null) => void;
  /** The Prompt, to flag the tags this character (and what they wear)
   * already sends. */
  prompt?: string;
  onPrompt?: (text: string) => void;
  /** With no character: the picker starts open. */
  open?: boolean;
  onPickerClose?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const { data: everyone } = useCharacters();
  const entry = useMemo(() => everyone?.find((c) => c.tag === value) ?? null, [everyone, value]);
  const recipeState = useRecipe(value);
  const { data: recipe, error } = recipeState;
  const genderPatch = useRecipePatch(value ?? "");
  const label = <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Character</span>;

  if (!value) {
    return (
      <Card className="flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2">
        {label}
        <div className="w-72 max-w-full">
          <CharacterPicker value={null} onChange={onChange} defaultOpen={open} onClose={onPickerClose} taken={taken} />
        </div>
      </Card>
    );
  }
  const { name } = displayName(entry ?? { tag: value });
  const kept = recipe?.identity.filter((c) => !c.dropped && !off?.tags.includes(c.tag)).map((c) => displayWord(c.tag)) ?? [];
  const lora = recipe?.lora;
  return (
    <Card className="px-3.5 py-2 hover:border-line-strong">
      {/* The same row open or folded, so the chevron stays under the mouse. A
          click on it toggles; its own buttons and the picker keep theirs. */}
      <div
        className="flex min-h-[2.25rem] cursor-pointer items-center gap-3"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button, a, input, [role=listbox], [role=dialog]")) setExpanded((x) => !x);
        }}
      >
      {label}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <CharacterPicker
          value={value}
          onChange={onChange}
          align="left"
          taken={taken}
          trigger={() => (
            <span className="group/pick -mx-1 inline-flex items-center gap-2.5 rounded-md px-1 py-0.5 hover:bg-line/60">
              {entry ? (
                <CharacterAvatar
                  src={entry.thumb_url}
                  face={entry.face}
                  focus={entry.focus}
                  aspect={entry.aspect}
                  letter={name}
                  className="h-7 w-7 text-xs ring-1 ring-line"
                />
              ) : (
                <UserRound size={18} className="text-faint" />
              )}
              <span className="shrink-0 font-semibold text-neutral-50">{name}</span>
              <ArrowLeftRight size={13} className="text-faint opacity-0 transition-opacity group-hover/pick:opacity-100" />
            </span>
          )}
        />
        {recipe && recipe.gender == null && <GenderPick recipe={recipe} onPick={(gender) => genderPatch.mutate({ gender })} small />}
        {/* Folded, each tag strikes on a click, as the outfit's do; open, the Identity row below has them (and the x). */}
        {recipeStuck(recipeState) ? (
          // Never loads: no such character (a name saved before it changed,
          // or one since deleted), or the request failed. Switch or remove it.
          <span className="min-w-0 flex-1">
            <span className={WARN_BADGE}>
              <CircleAlert size={12} />
              {isNotFound(error) ? "Not found" : "Didn't load"}
            </span>
          </span>
        ) : expanded ? (
          <span className="min-w-0 flex-1" />
        ) : off && recipe ? (
          <StrikeList
            tags={recipe.identity.filter((c) => !c.dropped).map((c) => c.tag)}
            struck={(tag) => off.tags.includes(tag)}
            onToggle={off.toggle}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-faint">
            {kept.join(", ")}
          </span>
        )}
        {lora &&
          (lora.file ? (
            loraSwitch ? (
              <Tooltip content={loraSwitch.off ? "Off for this batch" : undefined} bubble className="shrink-0">
                <button
                  type="button"
                  onClick={loraSwitch.toggle}
                  aria-pressed={!loraSwitch.off}
                  aria-label={`Use ${lora.stem}`}
                  className={cn(
                    "rounded-md px-1 py-0.5 font-mono text-xs hover:bg-line/60",
                    loraSwitch.off ? "text-faint line-through" : "text-neutral-300",
                  )}
                >
                  {lora.stem} {lora.strength.toFixed(2)}
                </button>
              </Tooltip>
            ) : (
              <span className="shrink-0 font-mono text-xs text-neutral-300">
                {lora.stem} {lora.strength.toFixed(2)}
              </span>
            )
          ) : (
            <Tooltip content="This ComfyUI doesn't have this LoRA, so it is left out of the prompt" bubble className="shrink-0">
              <span className={WARN_BADGE}>
                <Ban size={12} />
                <span className="font-mono line-through">{lora.stem}</span>
                not used
              </span>
            </Tooltip>
          ))}
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={!recipe}
        aria-label="Edit tags"
        className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-neutral-100 disabled:opacity-40"
      >
        <Pencil size={14} />
      </button>
      <ExpandButton open={expanded} onToggle={() => setExpanded((x) => !x)} />
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Remove character"
        className="rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
      >
        <X size={14} />
      </button>
      </div>
      {onOutfit && <WearsLine character={value} outfit={outfit} onOutfit={onOutfit} folded={!expanded} />}
      {recipe && prompt !== undefined && onPrompt && (
        <PromptRepeats
          repeats={tagRepeats([...characterTags(recipe, off?.tags), ...wornTags(outfit)], prompt)}
          prompt={prompt}
          onPrompt={onPrompt}
        />
      )}
      {expanded && recipe && (
        <div className="mt-2 space-y-4 border-t border-line pb-2 pt-3">
          <RecipeEditor recipe={recipe} label={name} installedLoras={installedLoras} rejectedLoras={rejectedLoras} off={off} />
          {outfit && onOutfit && <OutfitFold character={value} outfit={outfit} onOutfit={onOutfit} />}
          <Link to={characterHref(value)} className="inline-block text-xs text-muted hover:text-neutral-100">
            {recipe.count.toLocaleString()} {recipe.count === 1 ? "image" : "images"} · character page
          </Link>
        </div>
      )}
      {recipe && (
        <Dialog
          open={editing}
          onClose={() => setEditing(false)}
          title={name}
          titleAction={
            <ButtonLink to={characterHref(value)} variant="ghost" size="sm" className="-mr-2" onClick={() => setEditing(false)}>
              Open character page
              <ArrowUpRight size={14} />
            </ButtonLink>
          }
        >
          <div className="space-y-4">
            <RecipeEditor recipe={recipe} label={name} installedLoras={installedLoras} rejectedLoras={rejectedLoras} />
          </div>
        </Dialog>
      )}
    </Card>
  );
}

/** A character's Outfit line: the outfit picker, and folded, its tags; a
 * click on one strikes it for this batch (or brings it back). */
function WearsLine({
  character,
  outfit,
  onOutfit,
  folded,
}: {
  character: string;
  outfit: OutfitPick | undefined;
  onOutfit: (pick: OutfitPick | null) => void;
  folded: boolean;
}) {
  const struck = new Set(outfit?.dropped);
  return (
    <div className="flex min-h-[2.25rem] min-w-0 items-center gap-3">
      <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Outfit</span>
      <OutfitPicker character={character} value={outfit} onChange={onOutfit} />
      {folded && outfit && (
        <StrikeList tags={outfit.tags} struck={(tag) => struck.has(tag)} onToggle={(tag) => onOutfit(toggleWorn(outfit, tag))} />
      )}
    </div>
  );
}

/** A folded row's tags as a comma list; a click on one strikes it for this
 * batch (or brings it back). */
function StrikeList({
  tags,
  struck,
  onToggle,
}: {
  tags: readonly string[];
  struck: (tag: string) => boolean;
  onToggle: (tag: string) => void;
}) {
  return (
    <span className="min-w-0 flex-1 truncate text-xs text-faint">
      {tags.map((tag, i) => (
        <span key={tag}>
          {i > 0 && ", "}
          <button
            type="button"
            onClick={() => onToggle(tag)}
            className={cn("rounded-sm hover:text-neutral-100", struck(tag) && "text-faint/60 line-through")}
          >
            {displayWord(tag)}
          </button>
        </span>
      ))}
    </span>
  );
}

/** The unfolded character's outfit chips (edits are this batch's). */
function OutfitFold({
  character,
  outfit,
  onOutfit,
}: {
  character: string;
  outfit: OutfitPick;
  onOutfit: (pick: OutfitPick | null) => void;
}) {
  const { groups: known } = useCharacterOutfits(character);
  const { data: attireGroups } = useAttireGroups();
  // Tags added for this batch get their group from the attire list.
  const groups = useMemo(
    () => new Map([...Object.entries(attireGroups ?? {}), ...known]),
    [attireGroups, known],
  );
  return (
    <div>
      <FieldLabel>Outfit tags</FieldLabel>
      <OutfitChips pick={outfit} groups={groups} onChange={onOutfit} />
    </div>
  );
}

/**
 * The Character layer: one row per picked character, in prompt order, each
 * unfolding its recipe below. With none, just the picker.
 * `adding` (from the "+" between layers) shows one more row with the picker
 * open; `onAdded` is called when it closes, picked or not.
 */
export function CharacterLayer({
  value,
  onChange,
  installedLoras,
  rejectedLoras,
  adding = false,
  onAdded,
  outfits,
  onOutfit,
  prompt,
  onPrompt,
  identityOff,
  onIdentityOff,
  loraOff,
  onLoraOff,
}: {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  /** Characters whose LoRA is off for this batch; and the toggle. */
  loraOff?: readonly string[];
  onLoraOff?: (character: string) => void;
  /** Per character, identity tags struck for this batch; and the toggle. */
  identityOff?: Record<string, string[]>;
  onIdentityOff?: (character: string, tag: string) => void;
  outfits?: Outfits;
  onOutfit?: (character: string, pick: OutfitPick | null) => void;
  prompt?: string;
  onPrompt?: (text: string) => void;
  installedLoras: readonly string[];
  rejectedLoras: ReadonlySet<string>;
  adding?: boolean;
  onAdded?: () => void;
}) {
  const add = (tag: string) => {
    if (!value.includes(tag)) onChange([...value, tag]);
  };
  if (!value.length) {
    return (
      <CharacterRow
        value={null}
        onChange={(t) => t && add(t)}
        installedLoras={installedLoras}
        rejectedLoras={rejectedLoras}
        open={adding}
        onPickerClose={onAdded}
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {value.map((tag, i) => (
        <CharacterRow
          key={tag}
          value={tag}
          onChange={(t) => onChange(replaceCharacter(value, i, t))}
          installedLoras={installedLoras}
          rejectedLoras={rejectedLoras}
          taken={value}
          outfit={outfits?.[tag]}
          onOutfit={onOutfit && ((p) => onOutfit(tag, p))}
          prompt={prompt}
          onPrompt={onPrompt}
          off={onIdentityOff && { tags: identityOff?.[tag] ?? [], toggle: (t) => onIdentityOff(tag, t) }}
          loraSwitch={onLoraOff && { off: !!loraOff?.includes(tag), toggle: () => onLoraOff(tag) }}
        />
      ))}
      {adding && value.length < MAX_CHARACTERS && (
        <CharacterRow
          value={null}
          onChange={(t) => t && add(t)}
          installedLoras={installedLoras}
          rejectedLoras={rejectedLoras}
          open
          onPickerClose={onAdded}
          taken={value}
        />
      )}
    </div>
  );
}
