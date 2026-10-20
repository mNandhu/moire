import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, ChevronDown, Pencil, RotateCcw, Undo2, UserPlus, UserRound, X } from "lucide-react";
import { Badge, Card } from "../ui";
import { Picker, type PickerOption } from "../ui/Picker";
import { Dialog } from "../ui/Dialog";
import { CharacterAvatar } from "../CharacterAvatar";
import { useCharacters } from "../ImageCharacters";
import { cn } from "../../lib/cn";
import { characterHref, displayName, type CharacterEntry } from "../../lib/character";
import { displayWord } from "../../lib/compose";
import { putRecipe, recipeKey, useRecipe, type Recipe, type RecipePatch } from "../../lib/generate";
import { toggleDropped } from "../../lib/recipe";
import { FieldLabel, stemOf } from "./RunControls";
import { bareTagPool } from "./ChipInput";
import { ExpandButton } from "./Layers";
import { NewCharacterDialog } from "../NewCharacterDialog";
import { TagSuggestList, useTagMatches } from "../TagSuggestList";
import { useTagAggregate } from "../../lib/queries";

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
const NEW_CHARACTER = "\u0000new";

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
  const [creating, setCreating] = useState(false);
  const opts = useMemo(() => [...characterOptions(data ?? []), { value: NEW_CHARACTER, label: "New character" }], [data]);
  return (
    <>
      <Picker
        aria-label="Character"
        value={value ?? ""}
        options={opts}
        onChange={(v) => (v === NEW_CHARACTER ? setCreating(true) : onChange(v))}
        placeholder="Pick a character"
        searchable
        trigger={trigger}
        align={trigger ? "right" : "left"}
        className={trigger ? undefined : "w-full"}
      />
      {creating && <NewCharacterDialog open onClose={() => setCreating(false)} onCreated={onChange} />}
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

/** Type a tag to add to the identity: library tags as suggestions. */
function AddTagInput({ onAdd, taken }: { onAdd: (tag: string) => void; taken: ReadonlySet<string> }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const [moved, setMoved] = useState(false);
  const { data: tagAgg } = useTagAggregate({ includePrompt: true });
  const pool = useMemo(() => bareTagPool(tagAgg ?? []).filter((t) => !taken.has(t._id)), [tagAgg, taken]);
  const matches = useTagMatches(text, pool);
  const add = (tag: string) => {
    const t = tag.trim().replace(/\s+/g, "_");
    if (t) onAdd(t);
    setText("");
    setMoved(false);
  };
  return (
    <div className="relative">
      <input
        aria-label="Add identity tag"
        value={text}
        placeholder="Add tag"
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setMoved(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setMoved(true);
            setActive((a) => (e.key === "ArrowDown" ? Math.min(a + 1, matches.length - 1) : Math.max(a - 1, 0)));
          } else if (e.key === "Tab" && matches.length) {
            e.preventDefault();
            add(matches[active]._id);
          } else if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(moved && matches[active] ? matches[active]._id : text);
          } else if (e.key === "Escape") setText("");
        }}
        className="h-7 w-32 rounded-md border border-dashed border-line-strong bg-transparent px-2 text-sm text-neutral-100 placeholder:text-faint outline-none focus:w-48 focus:border-solid focus:border-brand-600/60"
      />
      {text.trim() && matches.length > 0 && (
        <div className="absolute left-0 top-full z-30 w-64">
          <TagSuggestList matches={matches} active={active} onActive={setActive} onPick={(m) => add(m._id)} />
        </div>
      )}
    </div>
  );
}

/**
 * A recipe's editable parts: identity tags (drop a computed one, add your
 * own) and the character LoRA. Changes are saved to the recipe at once, so
 * the composer and the character page show the same thing.
 */
export function RecipeEditor({
  recipe,
  label,
  installedLoras,
  rejectedLoras,
}: {
  recipe: Recipe;
  label: string;
  installedLoras: readonly string[];
  rejectedLoras?: ReadonlySet<string>;
}) {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (p: RecipePatch) => putRecipe(recipe.tag, p),
    onSuccess: (r) => qc.setQueryData(recipeKey(r.tag), r),
  });
  const added = recipe.identity.filter((c) => c.added).map((c) => c.tag);
  const taken = useMemo(() => new Set([recipe.tag, ...recipe.identity.map((c) => c.tag)]), [recipe]);
  return (
    <>
      <div>
        <FieldLabel>Identity</FieldLabel>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center rounded-md border border-brand-700 bg-brand-900/30 px-2 py-0.5 text-sm text-brand-100"
            title={recipe.tag}
          >
            {displayWord(recipe.tag)}
          </span>
          {recipe.identity.map((c) => (
            <span
              key={c.tag}
              title={c.dropped ? "Dropped from this recipe" : c.added ? "Added by you" : undefined}
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
          <AddTagInput taken={taken} onAdd={(tag) => !taken.has(tag) && patch.mutate({ added: [...added, tag] })} />
        </div>
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
  const { data: everyone } = useCharacters();
  const entry = useMemo(() => everyone?.find((c) => c.tag === value) ?? null, [everyone, value]);
  const { data: recipe, isError } = useRecipe(value);

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
        <RecipeEditor recipe={recipe} label={name} installedLoras={installedLoras} rejectedLoras={rejectedLoras} />
      )}
    </div>
  );
}

/**
 * The Character layer: one line (avatar, name, the identity tags it adds, its
 * LoRA) that expands into the full {@link CharacterBlock}; the pencil opens
 * just the recipe. With no character, just the picker.
 */
function CharacterRow({
  value,
  onChange,
  installedLoras,
  rejectedLoras,
  adder,
}: {
  value: string | null;
  onChange: (tag: string | null) => void;
  installedLoras: readonly string[];
  rejectedLoras: ReadonlySet<string>;
  /** Shown on the folded row: the control that adds another character. */
  adder?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const { data: everyone } = useCharacters();
  const entry = useMemo(() => everyone?.find((c) => c.tag === value) ?? null, [everyone, value]);
  const { data: recipe } = useRecipe(value);
  const label = <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Character</span>;

  if (!value) {
    return (
      <Card className="flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2">
        {label}
        <div className="w-72 max-w-full">
          <CharacterPicker value={null} onChange={onChange} />
        </div>
      </Card>
    );
  }
  if (expanded) {
    return (
      <Card className="p-4">
        <CharacterBlock value={value} onChange={onChange} installedLoras={installedLoras} rejectedLoras={rejectedLoras} />
        <div className="mt-2 flex justify-end">
          <ExpandButton open onToggle={() => setExpanded(false)} />
        </div>
      </Card>
    );
  }
  const { name } = displayName(entry ?? { tag: value });
  const kept = recipe?.identity.filter((c) => !c.dropped).map((c) => displayWord(c.tag)) ?? [];
  const lora = recipe?.lora;
  return (
    <Card className="flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2">
      {label}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {entry ? (
          <CharacterAvatar src={entry.thumb_url} face={entry.face} focus={entry.focus} aspect={entry.aspect} className="h-7 w-7 ring-1 ring-line" />
        ) : (
          <UserRound size={18} className="text-faint" />
        )}
        <span className="shrink-0 font-semibold text-neutral-50">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-faint" title={kept.join(", ")}>
          {kept.join(", ")}
        </span>
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
      <ExpandButton open={false} onToggle={() => setExpanded(true)} />
      {adder}
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Remove character"
        title="Remove character"
        className="rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
      >
        <X size={14} />
      </button>
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

/**
 * The Character layer: one row per picked character, in prompt order, each
 * folding open into its {@link CharacterBlock}; the last row adds another.
 * With none, just the picker.
 */
export function CharacterLayer({
  value,
  onChange,
  installedLoras,
  rejectedLoras,
}: {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  installedLoras: readonly string[];
  rejectedLoras: ReadonlySet<string>;
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
      />
    );
  }
  return (
    <div className="space-y-1.5">
      {value.map((tag, i) => (
        <CharacterRow
          key={tag}
          value={tag}
          onChange={(t) =>
            onChange(t ? value.map((x, j) => (j === i ? t : x)).filter((x, j, all) => all.indexOf(x) === j) : value.filter((_, j) => j !== i))
          }
          installedLoras={installedLoras}
          rejectedLoras={rejectedLoras}
          adder={
            i === value.length - 1 ? (
              <CharacterPicker
                value={null}
                onChange={add}
                trigger={() => (
                  <span
                    className="inline-flex rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
                    title="Add a character"
                    aria-label="Add a character"
                  >
                    <UserPlus size={15} />
                  </span>
                )}
              />
            ) : undefined
          }
        />
      ))}
    </div>
  );
}
