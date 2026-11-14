import { useSearchParams } from "react-router-dom";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { SETTINGS_SECTIONS } from "@/features/settings/components/registry";
import { SettingsTabs } from "@/features/settings/components/SettingsTabs";
import { AiSettingsFormProvider } from "@/features/ai/hooks/useAiSettingsForm";
import { PageHeader, PageBody } from "@/app/components/PageHeader";

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();

  const requested = params.get("section");
  const active =
    SETTINGS_SECTIONS.find((s) => s.id === requested) ?? SETTINGS_SECTIONS[0];

  const selectSection = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("section", id);
    setParams(next, { replace: true });
  };

  const ActivePanel = active.Component;

  useDocumentTitle(`${active.label} · Settings`);

  // A handful of sections reads best as tabs under one header; a second
  // sidebar holding two items was a nav for its own sake.
  return (
    <>
      <PageHeader title="Settings" />
      <PageBody className="space-y-5">
        <SettingsTabs sections={SETTINGS_SECTIONS} active={active} onSelect={selectSection} />
        {active.description && (
          <p className="text-sm text-muted">{active.description}</p>
        )}
        <AiSettingsFormProvider>
          <ActivePanel />
        </AiSettingsFormProvider>
      </PageBody>
    </>
  );
}
