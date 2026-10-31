import { useMutation } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useToast } from "../../components/Toasts";
import { fetchAiSettings, saveAiSettings, type AISettings } from "../../lib/ai";
import { errorText } from "../../lib/api";

type AiSettingsForm = {
  settings: AISettings | null;
  setSettings: React.Dispatch<React.SetStateAction<AISettings | null>>;
  saving: boolean;
  save: () => void;
};

function useAiSettingsFormState(): AiSettingsForm {
  const { push } = useToast();
  const [settings, setSettings] = useState<AISettings | null>(null);

  // Loaded once per visit, before the form shows, so it never overwrites an
  // edit.
  useEffect(() => {
    fetchAiSettings()
      .then(setSettings)
      .catch((e) => push(`Failed to load AI settings: ${errorText(e)}`, "error"));
  }, [push]);

  const saving = useMutation({
    mutationFn: saveAiSettings,
    onSuccess: (saved) => {
      setSettings(saved);
      push("Saved AI settings", "success");
    },
    onError: (e) => push(`Failed to save: ${errorText(e)}`, "error"),
  });
  const save = () => {
    if (settings) saving.mutate(settings);
  };

  return { settings, setSettings, saving: saving.isPending, save };
}

const AiSettingsFormContext = createContext<AiSettingsForm | null>(null);

/** One draft of the AI settings for the whole Settings page, so an unsaved
 * edit survives switching tabs. */
export function AiSettingsFormProvider({ children }: { children: ReactNode }) {
  const form = useAiSettingsFormState();
  return <AiSettingsFormContext.Provider value={form}>{children}</AiSettingsFormContext.Provider>;
}

/** The editable AI settings form a settings section reads and saves. */
export function useAiSettingsForm(): AiSettingsForm {
  const form = useContext(AiSettingsFormContext);
  if (!form) throw new Error("useAiSettingsForm needs an AiSettingsFormProvider");
  return form;
}
