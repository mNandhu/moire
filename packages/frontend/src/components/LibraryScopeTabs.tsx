import { cn } from "../lib/cn";
import { scanLabel, type Library } from "../lib/queries";

/**
 * Which libraries the gallery shows: all of them (the default, newest first)
 * or one. A scope, not a filter: it sits as tabs on the gallery band instead
 * of in the filter panel, so where you are is always visible. Hidden with
 * fewer than two libraries, where there is nothing to choose.
 */
export function LibraryScopeTabs({
  libraries,
  value,
  onChange,
}: {
  libraries: Library[];
  value: string | undefined;
  onChange: (libraryId: string | undefined) => void;
}) {
  if (libraries.length < 2) return null;
  const tabs = [
    { id: undefined, label: "All libraries", count: undefined, scan: undefined },
    ...libraries.map((l) => ({
      id: l._id as string | undefined,
      label: l.name || l.path,
      count: l.indexed_count,
      scan: l.scanning ? scanLabel(l) : undefined,
    })),
  ];
  return (
    <nav
      className="flex gap-1 overflow-x-auto px-4 md:px-6 [scrollbar-width:none]"
      aria-label="Library"
    >
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id ?? "all"}
            type="button"
            onClick={() => onChange(tab.id)}
            aria-current={on ? "page" : undefined}
            title={tab.label}
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 max-w-[16rem] px-3 py-2.5 text-sm border-b-2 transition-colors",
              on
                ? "border-brand-400 text-neutral-50 font-medium"
                : "border-transparent text-muted hover:text-neutral-100",
            )}
          >
            <span className="truncate">{tab.label}</span>
            {tab.scan ? (
              <span className="text-xs text-brand-300 whitespace-nowrap">{tab.scan}</span>
            ) : tab.count != null && (
              <span className="text-xs text-faint tabular-nums">
                {tab.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
