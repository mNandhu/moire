import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogFooter } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Field } from "./ui/Input";
import { Checkbox } from "./ui/Checkbox";
import { useToast } from "./Toasts";
import { CharacterAvatar } from "./CharacterAvatar";
import { FocusPicker } from "./FocusPicker";
import { setTagFocus, updateCharacter } from "../lib/tagMutations";
import { TAGS_KEY } from "../lib/queries";
import { characterHref, type CharacterPage } from "../lib/character";
import { errorText } from "../lib/api";

/**
 * The tag page's Edit: the character dialog's cover framing, for a tag that
 * isn't a person, and the switch that makes it one (it then gets a
 * character page with a name, colour and recipe).
 */
export function TagEditDialog({ open, onClose, c }: { open: boolean; onClose: () => void; c: CharacterPage }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { push } = useToast();
  // Mounted only while open (see CharacterPage), so these start from the
  // stored values each time.
  const [focus, setFocus] = useState<[number, number] | null>(c.focus);
  const [character, setCharacter] = useState(false);
  const save = useMutation({
    mutationFn: async () => {
      if (focus?.[0] !== c.focus?.[0] || focus?.[1] !== c.focus?.[1]) await setTagFocus(c.tag, focus);
      if (character) await updateCharacter(c.tag, { kind: "character" });
      await qc.invalidateQueries({ queryKey: TAGS_KEY });
    },
    onSuccess: () => {
      onClose();
      if (character) navigate(characterHref(c.tag));
    },
    onError: (e) => push(`Couldn't save: ${errorText(e)}`, "error"),
  });

  // Not closed mid-save: its onSuccess still closes and may navigate.
  const close = () => {
    if (!save.isPending) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Edit tag"
      className="max-w-lg"
      footer={
        <DialogFooter onCancel={close} onConfirm={() => save.mutate()} pending={save.isPending} />
      }
    >
      <div className="space-y-5">
        {c.thumb_url && (
          <Field
            label="Cover"
            hint={
              c.face
                ? "Cropped to the face Moiré found. Click elsewhere to centre it there instead."
                : "Click where the cover should be centred."
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
        <Checkbox
          id="tag-is-character"
          checked={character}
          onChange={setCharacter}
          label="This is a character"
          hint="Gives the tag a character page: a name, colour, avatar on images, and a recipe for Generate."
        />
      </div>
    </Dialog>
  );
}
