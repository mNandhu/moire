import { useEffect, useState } from "react";
import { useToast } from "../../components/Toasts";
import { useAiStatus } from "../../hooks/useAiStatus";
import { fetchAiSettings, saveAiSettings, type AISettings } from "../../lib/ai";
import { errorText } from "../../lib/api";

/** The editable AI settings form a settings section reads and saves. */
export function useAiSettingsForm() {
  const { push } = useToast();
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [saving, setSaving] = useState(false);
  const { data: status } = useAiStatus();

  useEffect(() => {
    fetchAiSettings()
      .then(setSettings)
      .catch((e) => push(`Failed to load AI settings: ${errorText(e)}`, "error"));
  }, [push]);

  // Seed the editable form from polled status until the user's copy loads.
  useEffect(() => {
    if (status?.settings) setSettings((prev) => prev ?? status.settings);
  }, [status?.settings]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      setSettings(await saveAiSettings(settings));
      push("Saved AI settings", "success");
    } catch (e) {
      push(`Failed to save: ${errorText(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return { settings, setSettings, saving, save };
}
