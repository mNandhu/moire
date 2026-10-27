import { Section } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Checkbox } from "../../../components/ui/Checkbox";
import { useAiSettingsForm } from "../useAiSettingsForm";

export function PromptTagsSection() {
  const { settings, setSettings, saving, save } = useAiSettingsForm();

  return (
    <div className="space-y-5">
      <Section>
      {settings ? (
        <Checkbox
          id="prompt_positive_only"
          checked={settings.prompt_positive_only}
          onChange={(v) =>
            setSettings({ ...settings, prompt_positive_only: v })
          }
          label="Positive prompt only"
          hint="Derive prompt: tags from the positive prompt only, so negative-prompt words don't pollute search."
        />
      ) : (
        <div className="text-sm text-faint">Loading settings…</div>
      )}
      </Section>

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={!settings || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
