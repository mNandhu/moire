import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Ban, Check, Pencil, Plus, RotateCcw, Undo2, UserRound, X } from "lucide-react";
import { Badge, Card } from "../ui";
import { Picker, type PickerOption } from "../ui/Picker";
import { Dialog } from "../ui/Dialog";
import { CharacterAvatar } from "../CharacterAvatar";
import { useCharacters } from "../../lib/queries";
import { cn } from "../../lib/cn";
import { characterHref, displayName, fewImagesNote, type CharacterEntry } from "../../lib/character";
import { useChipBorderStyle } from "../../hooks/useTagMarks";
import { displayWord } from "../../lib/compose";
import { putRecipe, recipeKey, useRecipe, type Gender, type Recipe, type RecipePatch } from "../../lib/generate";
import { characterTags, toggleDropped } from "../../lib/recipe";
import { tagRepeats } from "../../lib/promptRepeats";
import { PromptRepeats } from "./PromptRepeats";
import { FieldLabel } from "./RunControls";
import { stemOf } from "../../lib/modelNames";
import { ExpandButton } from "./Layers";
import { replaceCharacter } from "../../lib/generateForm";
import { MAX_CHARACTERS } from "../../lib/generationLimits";
import { NewCharacterDialog } from "../NewCharacterDialog";
import { OutfitChips, OutfitPicker } from "./Outfit";
import { useCharacterOutfits } from "../../hooks/useOutfitData";
import { toggleWorn, wornTags, type OutfitPick, type Outfits } from "../../lib/outfit";
import { TagAddInput } from "../TagAddInput";
import { useAttireGroups } from "../../lib/queries";

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

const NEW_CHARACTER = "\u0000new";

/** The character picker: avatars, search over every name, image counts. */
function CharacterPicker({
  value,
  onChange,
  trigger,
  defaultOpen,
  onClose,
  align,
  taken,
}: {
  value: string | null;
  onChange: (tag: string) => void;
  trigger?: (p: { open: boolean; label: string | null }) => React.ReactNode;
  defaultOpen?: boolean;
  onClose?: () => void;
  align?: "left" | "right";
  /** Characters already in the prompt, left out of the list. */
  taken?: readonly string[];
}) {
  const { data } = useCharacters();
  const [creating, setCreating] = useState(false);
  const [initialTag, setInitialTag] = useState("");
  // The chosen one first, then everyone not already in the prompt.
  const opts = useMemo(() => {
    const list = data ?? [];
    const chosen = list.filter((c) => c.tag === value);
    return characterOptions([...chosen, ...list.filter((c) => c.tag !== value && !taken?.includes(c.tag))]);
  }, [data, taken, value]);
  const pinned = useCallback(
    (q: string): PickerOption => ({
      // Carries the search, which starts the new character's tag.
      value: NEW_CHARACTER + q,
      label: q ? `Create "${q}"` : "New character",
      icon: (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-muted">
          <Plus size={13} />
        </span>
      ),
    }),
    [],
  );
  return (
    <>
      <Picker
        aria-label="Character"
        value={value ?? ""}
        options={opts}
        onChange={(v) => {
          if (!v.startsWith(NEW_CHARACTER)) return onChange(v);
          setInitialTag(v.slice(NEW_CHARACTER.length));
          setCreating(true);
        }}
        pinned={pinned}
        checks={false}
        placeholder="Pick a character"
        searchable
        trigger={trigger}
        defaultOpen={defaultOpen}
        onClose={onClose}
        align={align ?? (trigger ? "right" : "left")}
        className={trigger ? undefined : "w-full"}
      />
      {creating && <NewCharacterDialog open initialTag={initialTag} onClose={() => setCreating(false)} onCreated={onChange} />}
    </>
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
function useRecipePatch(tag: string) {
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
                    <span
                      key={c.tag}
                      title={struck ? "Left out of this batch" : undefined}
                      style={struck ? undefined : chipBorderStyle(c.tag)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border pl-2 pr-1 py-0.5 text-sm",
                        struck ? "border-line/60 text-faint line-through" : "border-line bg-raised text-neutral-100",
                      )}
                    >
                      {displayWord(c.tag)}
                      <button
                        type="button"
                        onClick={() => off.toggle(c.tag)}
                        aria-label={`${struck ? "Bring back" : "Leave out"} ${displayWord(c.tag)}`}
                        title={struck ? "Bring back" : "Leave out of this batch"}
                        className="rounded p-0.5 text-muted no-underline hover:bg-line hover:text-neutral-100"
                      >
                        {struck ? <Undo2 size={13} /> : <X size={13} />}
                      </button>
                    </span>
                  );
                })
            : recipe.identity.map((c) => (
            <span
              key={c.tag}
              title={c.dropped ? "Dropped from this recipe" : c.added ? "Added by you" : undefined}
              style={c.dropped ? undefined : chipBorderStyle(c.tag)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border pl-2 pr-1 py-0.5 text-sm",
                c.dropped
                  ? "border-line/60 text-faint line-through"
                  : c.added
                    ? "border-brand-800 bg-raised text-neutral-100"
                    : "border-line bg-raised text-neutral-100",
              )}
            >
              {displayWord(c.tag)}
              <button
                type="button"
                onClick={() =>
                  patch.mutate(
                    c.added ? { added: added.filter((a) => a !== c.tag) } : { dropped: toggleDropped(recipe, c.tag) },
                  )
                }
                aria-label={`${c.dropped ? "Restore" : c.added ? "Remove" : "Drop"} ${displayWord(c.tag)}`}
                className="rounded p-0.5 text-muted no-underline hover:bg-line hover:text-neutral-100"
              >
                {c.dropped ? <Undo2 size={13} /> : <X size={13} />}
              </button>
            </span>
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
}: {
  value: string | null;
  onChange: (tag: string | null) => void;
  /** Identity tags struck for this batch, and the toggle. */
  off?: { tags: readonly string[]; toggle: (tag: string) => void };
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
  const { data: recipe } = useRecipe(value);
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
            <span className="group/pick -mx-1 inline-flex items-center gap-2.5 rounded-md px-1 py-0.5 hover:bg-line/60" title="Change character">
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
        {expanded ? (
          <span className="min-w-0 flex-1" />
        ) : off && recipe ? (
          <span
            className="min-w-0 flex-1 truncate text-xs text-faint"
            title={recipe.identity.filter((c) => !c.dropped).map((c) => c.tag).join(", ")}
          >
            {recipe.identity
              .filter((c) => !c.dropped)
              .map((c, i) => (
                <span key={c.tag}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={() => off.toggle(c.tag)}
                    title={off.tags.includes(c.tag) ? "Bring back" : "Leave out of this batch"}
                    className={cn("rounded-sm hover:text-neutral-100", off.tags.includes(c.tag) && "text-faint/60 line-through")}
                  >
                    {displayWord(c.tag)}
                  </button>
                </span>
              ))}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-faint" title={kept.join(", ")}>
            {kept.join(", ")}
          </span>
        )}
        {lora &&
          (lora.file ? (
            <span className="shrink-0 font-mono text-xs text-neutral-300" title="Character LoRA">
              {lora.stem} {lora.strength.toFixed(2)}
            </span>
          ) : (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-amber-700/70 bg-amber-950/20 px-1.5 py-0.5 text-xs text-amber-200"
              title="This ComfyUI doesn't have this LoRA, so it is left out of the prompt"
            >
              <Ban size={12} />
              <span className="font-mono line-through">{lora.stem}</span>
              not used
            </span>
          ))}
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        disabled={!recipe}
        aria-label="Edit tags"
        title="Edit tags"
        className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-neutral-100 disabled:opacity-40"
      >
        <Pencil size={14} />
      </button>
      <ExpandButton open={expanded} onToggle={() => setExpanded((x) => !x)} />
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Remove character"
        title="Remove character"
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
        <Dialog open={editing} onClose={() => setEditing(false)} title={name}>
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
  const worn = wornTags(outfit).map(displayWord).join(", ");
  const struck = new Set(outfit?.dropped);
  return (
    <div className="flex min-h-[2.25rem] min-w-0 items-center gap-3">
      <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Outfit</span>
      <OutfitPicker character={character} value={outfit} onChange={onOutfit} />
      {folded && outfit && (
        <span className="min-w-0 flex-1 truncate text-xs text-faint" title={worn}>
          {outfit.tags.map((tag, i) => (
            <span key={tag}>
              {i > 0 && ", "}
              <button
                type="button"
                onClick={() => onOutfit(toggleWorn(outfit, tag))}
                title={struck.has(tag) ? "Bring back" : "Leave out of this batch"}
                className={cn("rounded-sm hover:text-neutral-100", struck.has(tag) && "text-faint/60 line-through")}
              >
                {displayWord(tag)}
              </button>
            </span>
          ))}
        </span>
      )}
    </div>
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
}: {
  value: readonly string[];
  onChange: (tags: string[]) => void;
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
