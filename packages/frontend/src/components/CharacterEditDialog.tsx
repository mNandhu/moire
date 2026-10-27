import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Input";
import { Checkbox } from "./ui/Checkbox";
import { useToast } from "./Toasts";
import { CharacterAvatar } from "./CharacterAvatar";
import { FocusPicker } from "./FocusPicker";
import { cn } from "../lib/cn";
import { deleteCharacter, updateCharacter } from "../lib/imageMutations";
import { TAGS_KEY } from "../lib/queries";
import { useComfyModels, useRecipe } from "../lib/generate";
import { RecipeEditor } from "./generate/CharacterBlock";
import { useConfirm } from "./ConfirmDialog";
import { loadDraft, saveDraft } from "../lib/generateDraft";
import {
  SWATCHES,
  characterColours,
  characterName,
  type CharacterPage,
  type CharacterPatch,
} from "../lib/character";
import { errorText } from "../lib/api";

/**
 * What the user decides for a character: the name and series shown, the
 * colour their page is lit with, where their avatar is centred, whether the
 * tag is a character at all (the tagger's list can be wrong), and what
 * Generate writes for them (identity tags and character LoRA, saved as they
 * change). A character made by hand can be deleted here while no image has
 * them.
 */
export function CharacterEditDialog({
  open,
  onClose,
  c,
}: {
  open: boolean;
  onClose: () => void;
  c: CharacterPage;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { push } = useToast();
  const fromTag = characterName(c.tag);
  // Mounted only while open (see CharacterPage), so these start from the
  // stored values each time and a refetch of `c` can't wipe a draft.
  const [name, setName] = useState(c.name ?? "");
  const [series, setSeries] = useState(c.series ?? "");
  const [color, setColor] = useState<string | null>(c.color);
  const [focus, setFocus] = useState<[number, number] | null>(c.focus);
  const [notCharacter, setNotCharacter] = useState(c.kind === "general");
  const [saving, setSaving] = useState(false);

  const auto = characterColours({ ...c, color: null })[0];
  const { data: recipe } = useRecipe(c.tag);
  const { data: models } = useComfyModels();

  const confirm = useConfirm();
  const remove = async () => {
    const ok = await confirm({
      title: `Delete ${name || fromTag.name}?`,
      message: "Their identity tags, LoRA and own outfits go too. Shared outfits stay.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setSaving(true);
    try {
      await deleteCharacter(c.tag);
      // Not left picked in the composer.
      const draft = loadDraft();
      if (draft.characters.includes(c.tag)) saveDraft({ ...draft, characters: draft.characters.filter((t) => t !== c.tag) });
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
      onClose();
      navigate("/tags");
    } catch (e) {
      push(`Couldn't delete: ${errorText(e)}`, "error");
      setSaving(false);
    }
  };

  const save = async () => {
    const patch: CharacterPatch = {};
    if (name !== (c.name ?? "")) patch.name = name;
    if (series !== (c.series ?? "")) patch.series = series;
    if (color !== c.color) patch.color = color ?? "";
    if (focus?.[0] !== c.focus?.[0] || focus?.[1] !== c.focus?.[1]) {
      patch.focus_x = focus ? focus[0] : "";
      patch.focus_y = focus ? focus[1] : "";
    }
    if (notCharacter !== (c.kind === "general")) patch.kind = notCharacter ? "general" : "";
    setSaving(true);
    try {
      if (Object.keys(patch).length) await updateCharacter(c.tag, patch);
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
      onClose();
      if (patch.kind === "general") navigate(`/tags?${new URLSearchParams({ tag: c.tag })}`);
    } catch (e) {
      push(`Couldn't save: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Edit character"
      className="max-w-lg"
      footer={
        <>
          {c.made && (
            <Button variant="ghost" className="mr-auto text-red-300" onClick={() => void remove()} disabled={saving}>
              Delete character
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor="character-name">
            <Input id="character-name" value={name} placeholder={fromTag.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Series" htmlFor="character-series">
            <Input
              id="character-series"
              value={series}
              placeholder={fromTag.series ?? "None"}
              onChange={(e) => setSeries(e.target.value)}
            />
          </Field>
        </div>

        {c.thumb_url && (
          <Field
            label="Avatar"
            hint={
              c.face
                ? "Cropped to the face Moiré found. Click elsewhere to centre it there instead."
                : "Click the face to centre the avatar on it."
            }
          >
            <div className="flex items-center gap-4">
              <FocusPicker src={c.thumb_url} aspect={c.aspect} face={c.face} focus={focus} onChange={setFocus} />
              <div className="flex flex-col items-center gap-2">
                <CharacterAvatar
                  src={c.thumb_url}
                  face={c.face}
                  focus={focus}
                  aspect={c.aspect}
                  className="h-20 w-20 ring-1 ring-line"
                />
                {focus && (
                  <Button size="sm" variant="ghost" onClick={() => setFocus(null)}>
                    {c.face ? "Back to face" : "Reset"}
                  </Button>
                )}
              </div>
            </div>
          </Field>
        )}

        <Field label="Colour" hint="Lights the page. Auto reads it from their hair and eye tags.">
          <div className="flex flex-wrap gap-2">
            <Swatch
              colour={auto}
              label="Auto"
              on={color === null}
              onPick={() => setColor(null)}
            />
            {SWATCHES.map((s) => (
              <Swatch key={s} colour={s} on={color === s} onPick={() => setColor(s)} />
            ))}
          </div>
        </Field>

        {recipe && (
          <section className="space-y-4 rounded-lg border border-line p-4">
            <h3 className="text-xs font-medium text-muted" title="What Generate writes for them. Saved as you change it.">
              For Generate
            </h3>
            <RecipeEditor recipe={recipe} label={name || fromTag.name} installedLoras={models?.loras ?? []} />
          </section>
        )}

        {!c.made && (
        <Checkbox
          id="character-not"
          checked={notCharacter}
          onChange={setNotCharacter}
          label="Not a character"
          hint="Treat this tag as an ordinary tag: no character page, no avatar on images."
        />
        )}
      </div>
    </Dialog>
  );
}

function Swatch({
  colour,
  label,
  on,
  onPick,
}: {
  colour: string | undefined;
  label?: string;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      aria-label={label ?? colour}
      title={label ?? colour}
      className={cn(
        "relative h-8 rounded-full ring-1 ring-line inline-flex items-center justify-center text-2xs font-medium text-white",
        label ? "px-3" : "w-8",
        on && "ring-2 ring-white",
      )}
      style={{ background: colour ?? "#3b3946" }}
    >
      {label}
      {on && !label && <Check size={14} />}
    </button>
  );
}
