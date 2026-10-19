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
import { cn } from "../lib/cn";
import { updateCharacter } from "../lib/imageMutations";
import { TAGS_KEY } from "../lib/queries";
import {
  SWATCHES,
  characterColours,
  characterName,
  type CharacterPage,
  type CharacterPatch,
} from "../lib/character";

/**
 * What the user decides for a character: the name and series shown, the
 * colour their page is lit with, where their avatar is centred, and whether
 * the tag is a character at all (the tagger's list can be wrong).
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
      push(`Couldn't save: ${String(e)}`, "error");
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
              <button
                type="button"
                aria-label="Set the avatar's centre"
                className="relative h-44 max-w-full rounded-lg overflow-hidden bg-raised cursor-crosshair"
                style={{ aspectRatio: c.aspect ?? 1 }}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setFocus([
                    Math.round(((e.clientX - r.left) / r.width) * 100) / 100,
                    Math.round(((e.clientY - r.top) / r.height) * 100) / 100,
                  ]);
                }}
              >
                <img src={c.thumb_url} alt="" className="w-full h-full object-cover" />
                {c.face && !focus && (
                  <span
                    className="absolute border border-dashed border-white/80 rounded"
                    style={{
                      left: `${(c.face[0] - c.face[2] / 2) * 100}%`,
                      top: `${(c.face[1] - c.face[3] / 2) * 100}%`,
                      width: `${c.face[2] * 100}%`,
                      height: `${c.face[3] * 100}%`,
                    }}
                  />
                )}
                {focus && (
                  <span
                    className="absolute h-4 w-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow"
                    style={{ left: `${focus[0] * 100}%`, top: `${focus[1] * 100}%` }}
                  />
                )}
              </button>
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

        <Checkbox
          id="character-not"
          checked={notCharacter}
          onChange={setNotCharacter}
          label="Not a character"
          hint="Treat this tag as an ordinary tag: no character page, no avatar on images."
        />
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
