import { RotateCcw } from "lucide-react";
import { Button } from "../ui/Button";

/** The footer of a settings section: back to defaults on the left, save on
 * the right (enabled only while there is something to save). */
export function SaveBar({
  dirty,
  saving,
  resetDisabled,
  onReset,
  onSave,
}: {
  dirty: boolean;
  saving: boolean;
  resetDisabled: boolean;
  onReset: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex justify-between gap-2">
      <Button variant="ghost" onClick={onReset} disabled={resetDisabled}>
        <RotateCcw size={14} /> Reset to defaults
      </Button>
      <Button variant="primary" onClick={onSave} disabled={!dirty || saving}>
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </div>
  );
}
