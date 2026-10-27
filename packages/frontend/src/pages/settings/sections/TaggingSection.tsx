import { Section } from "../../../components/ui/Card";
import { ModelSection } from "./ModelSection";
import { AiControllerProvider } from "../../../hooks/useAiController";
import { Button } from "../../../components/ui/Button";
import { Input, Field } from "../../../components/ui/Input";
import { Checkbox } from "../../../components/ui/Checkbox";
import { useAiSettingsForm } from "../useAiSettingsForm";

export function TaggingSection() {
  const { settings, setSettings, saving, save } = useAiSettingsForm();

  return (
    <div className="space-y-5">
      {settings ? (
        <>
          <Section
            title="Thresholds"
            description="Minimum confidence for a tag to be kept, and a cap per image."
          >
            <div className="space-y-4">
            {/* Four short numbers: one row of compact fields, not four
                half-page-wide inputs holding "0.35". */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="General threshold" htmlFor="ai_general_thresh">
                <Input
                  id="ai_general_thresh"
                  type="number"
                  step="0.01"
                  value={settings.general_thresh}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      general_thresh: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Character threshold" htmlFor="ai_character_thresh">
                <Input
                  id="ai_character_thresh"
                  type="number"
                  step="0.01"
                  value={settings.character_thresh}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      character_thresh: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Max general tags" htmlFor="ai_max_general">
                <Input
                  id="ai_max_general"
                  type="number"
                  min={0}
                  value={settings.max_general}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      max_general: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Max character tags" htmlFor="ai_max_character">
                <Input
                  id="ai_max_character"
                  type="number"
                  min={0}
                  value={settings.max_character}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      max_character: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
              <Checkbox
                id="general_mcut"
                checked={settings.general_mcut}
                onChange={(v) => setSettings({ ...settings, general_mcut: v })}
                label="Auto threshold for general tags (MCut)"
                hint="Cut at the biggest drop between sorted tag scores instead of a fixed value."
              />
              <Checkbox
                id="character_mcut"
                checked={settings.character_mcut}
                onChange={(v) =>
                  setSettings({ ...settings, character_mcut: v })
                }
                label="Auto threshold for character tags (MCut)"
                hint="The same, applied to character tags."
              />
            </div>
            </div>
          </Section>

          <Section title="Model">
            <div className="space-y-5">
            <AiControllerProvider>
              <ModelSection />
            </AiControllerProvider>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-4 border-t border-line">
              <Field
                label="Model (Hugging Face repo)"
                htmlFor="ai_model_repo"
                hint={
                  <a
                    href="https://huggingface.co/SmilingWolf/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-neutral-300 underline underline-offset-2"
                  >
                    Browse available models ↗
                  </a>
                }
              >
                <Input
                  id="ai_model_repo"
                  value={settings.model_repo}
                  onChange={(e) =>
                    setSettings({ ...settings, model_repo: e.target.value })
                  }
                  placeholder="SmilingWolf/wd-vit-tagger-v3"
                />
              </Field>
              <Field
                label="Unload after idle (seconds)"
                htmlFor="ai_idle_unload"
                hint="0 disables auto-unload."
              >
                <Input
                  id="ai_idle_unload"
                  type="number"
                  min={0}
                  value={settings.idle_unload_s}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      idle_unload_s: Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field
                label="Download folder"
                htmlFor="ai_cache_dir"
                hint="Relative paths resolve from the repo root."
                className="md:col-span-2"
              >
                <Input
                  id="ai_cache_dir"
                  value={settings.cache_dir}
                  onChange={(e) =>
                    setSettings({ ...settings, cache_dir: e.target.value })
                  }
                />
              </Field>
            </div>
            </div>
          </Section>
        </>
      ) : (
        <div className="text-sm text-faint">Loading settings…</div>
      )}

      <div className="flex justify-end">
        <Button variant="primary" onClick={save} disabled={!settings || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
