import { useSearchParams } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { cn } from "../lib/cn";
import { SettingsProvider } from "./settings/SettingsContext";
import { SETTINGS_SECTIONS } from "./settings/registry";
import { PageHeader, PageBody } from "../components/ui/PageHeader";

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
    <SettingsProvider>
      <PageHeader title="Settings" />
      <PageBody className="space-y-5">
        <nav
          className="flex gap-1 border-b border-line -mt-1 overflow-x-auto [scrollbar-width:none]"
          aria-label="Settings sections"
        >
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon;
            const on = section.id === active.id;
            return (
              <button
                key={section.id}
                onClick={() => selectSection(section.id)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "relative md:-mb-px shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 transition-colors",
                  on
                    ? "border-brand-400 text-neutral-50 font-medium"
                    : "border-transparent text-muted hover:text-neutral-100",
                )}
              >
                <Icon size={16} className="shrink-0" />
                {section.label}
              </button>
            );
          })}
        </nav>
        {active.description && (
          <p className="text-sm text-muted">{active.description}</p>
        )}
        <ActivePanel />
      </PageBody>
    </SettingsProvider>
  );
}
