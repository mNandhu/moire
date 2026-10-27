import { useCallback, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Picker, type PickerOption } from "./ui/Picker";
import { CharacterAvatar } from "./CharacterAvatar";
import { NewCharacterDialog } from "./NewCharacterDialog";
import { useCharacters } from "../lib/queries";
import { displayName, type CharacterEntry } from "../lib/character";

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
export function CharacterPicker({
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
