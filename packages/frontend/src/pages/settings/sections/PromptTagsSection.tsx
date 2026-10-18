import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { useSettings } from "../SettingsContext";

export function PromptTagsSection() {
  const { settings, setSettings, saving, save } = useSettings();

  return (
    <Card className="p-5 space-y-4">
      {settings ? (
        <Checkbox
          id="prompt_positive_only"
          checked={settings.prompt_positive_only}
          onChange={(v) =>
            setSettings({ ...settings, prompt_positive_only: v })
          }
          label="Positive prompt only"
          hint="Derive prompt: tags from the positive prompt only, so negative-prompt words don't pollute search. Applies on next reprojection."
        />
      ) : (
        <div className="text-sm text-faint">Loading settings…</div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button variant="primary" onClick={save} disabled={!settings || saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </Card>
  );
}
