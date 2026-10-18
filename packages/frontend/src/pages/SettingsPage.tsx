import { useSearchParams } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { cn } from "../lib/cn";
import { SettingsProvider } from "./settings/SettingsContext";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "./settings/registry";

function SubNavButton({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const Icon = section.icon;
  return (
    <button
      onClick={() => onSelect(section.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-neutral-800 text-white font-medium"
          : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200"
      )}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-0.5 rounded-full bg-brand-500" />
      )}
      <Icon size={18} className="shrink-0" />
      <span className="truncate">{section.label}</span>
    </button>
  );
}

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
  const ActiveIcon = active.icon;

  useDocumentTitle(`${active.label} · Settings`);

  return (
    <SettingsProvider>
      <div className="p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* Submenu */}
          <aside className="lg:w-56 lg:shrink-0">
            <div className="px-3 pb-4">
              <h2 className="text-2xl font-semibold text-neutral-50">Settings</h2>
            </div>
            <nav className="space-y-5">
              {SETTINGS_GROUPS.map((group, gi) => (
                <div key={group.title ?? gi} className="space-y-1">
                  {group.title && (
                    <div className="px-3 mb-1 text-xs font-medium text-faint">
                      {group.title}
                    </div>
                  )}
                  {group.items.map((section) => (
                    <SubNavButton
                      key={section.id}
                      section={section}
                      active={section.id === active.id}
                      onSelect={selectSection}
                    />
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          {/* Content panel */}
          <div className="min-w-0 flex-1 space-y-5">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-neutral-800/80 text-brand-300 shrink-0">
                <ActiveIcon size={20} />
              </span>
              <div className="min-w-0">
                <h3 className="text-lg font-bold tracking-tight text-neutral-100 truncate">
                  {active.label}
                </h3>
                {active.description && (
                  <p className="text-sm text-neutral-400">
                    {active.description}
                  </p>
                )}
              </div>
            </div>

            <ActivePanel />
          </div>
        </div>
      </div>
    </SettingsProvider>
  );
}
