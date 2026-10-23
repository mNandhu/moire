import { Picker } from "../ui/Picker";
import { presetChoice, presetOptions, NONE, type PresetLike } from "../../lib/presetOptions";

/**
 * A picker over saved presets: None, each preset, New. A preset a layer
 * still points at after it was deleted shows faded. `presets` are the ones
 * that can be picked here; `loaded` says they have arrived.
 */
export function PresetPicker<P extends PresetLike>({
  presets,
  loaded,
  value,
  onPick,
  onNew,
  "aria-label": ariaLabel,
  placeholder,
  noneDetail,
  showText,
}: {
  presets: readonly P[];
  loaded: boolean;
  /** The selected preset's id. */
  value: string | undefined;
  /** A preset, or null for None. */
  onPick: (p: P | null) => void;
  onNew: () => void;
  "aria-label": string;
  placeholder?: string;
  /** What None means, beside it. */
  noneDetail?: string;
  /** Each preset's text beside its name. */
  showText?: boolean;
}) {
  return (
    <Picker
      aria-label={ariaLabel}
      value={value ?? NONE}
      options={presetOptions(presets, value, loaded, { noneDetail, showText })}
      placeholder={placeholder}
      onChange={(v) => {
        const choice = presetChoice(presets, v);
        if (!choice) return;
        if ("create" in choice) onNew();
        else if ("none" in choice) onPick(null);
        else onPick(choice.preset);
      }}
      className="w-full"
    />
  );
}
