import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import type { SettingsSection } from "@/features/settings/components/registry";
import { visibleTabCount } from "@/features/settings/lib/tabFit";

const GAP = 4; // gap-1
const CHEVRON = 18; // the chevron and its gap, when More names a tab

const TAB =
  "relative md:-mb-px shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-3 py-2.5 text-sm border-b-2 transition-colors";
const tabLook = (on: boolean) =>
  on ? "border-brand-400 text-neutral-50 font-medium" : "border-transparent text-muted hover:text-neutral-100";

/**
 * The Settings tab strip. Tabs that don't fit the row go under "More" at its
 * end; when the open section is one of them, More names it. A hidden copy of
 * the row measures each tab, so the split follows the page's width.
 */
export function SettingsTabs({
  sections,
  active,
  onSelect,
}: {
  sections: SettingsSection[];
  active: SettingsSection;
  onSelect: (id: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(sections.length);
  const activeIndex = sections.findIndex((s) => s.id === active.id);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const update = () => {
      const kids = [...measure.children] as HTMLElement[];
      const widths = kids.slice(0, sections.length).map((k) => k.offsetWidth);
      setCount(
        visibleTabCount({
          widths,
          available: nav.clientWidth,
          gap: GAP,
          moreWidth: kids[sections.length].offsetWidth,
          activeIndex,
          activeMoreWidth: widths[activeIndex] + CHEVRON,
        }),
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [sections, activeIndex]);

  const shown = sections.slice(0, count);
  const moved = sections.slice(count);
  const activeMoved = activeIndex >= count;

  return (
    <nav ref={navRef} className="relative flex gap-1 border-b border-line -mt-1" aria-label="Settings sections">
      {/* Measures every tab (as open, the wider weight) and More. */}
      <div className="pointer-events-none invisible absolute left-0 top-0 h-0 w-0 overflow-hidden" aria-hidden>
        <div ref={measureRef} className="flex w-max gap-1">
          {sections.map((s) => (
            <span key={s.id} className={cn(TAB, tabLook(true))}>
              <s.icon size={16} className="shrink-0" />
              {s.label}
            </span>
          ))}
          <span className={cn(TAB, tabLook(false))}>
            More
            <ChevronDown size={14} />
          </span>
        </div>
      </div>

      {shown.map((section) => {
        const on = section.id === active.id;
        return (
          <button
            key={section.id}
            onClick={() => onSelect(section.id)}
            aria-current={on ? "page" : undefined}
            className={cn(TAB, tabLook(on))}
          >
            <section.icon size={16} className="shrink-0" />
            {section.label}
          </button>
        );
      })}
      {moved.length > 0 && (
        <DropdownMenu
          aria-label="More settings"
          below
          items={moved.map((s) => ({
            label: s.label,
            icon: <s.icon size={16} className="shrink-0" />,
            onClick: () => onSelect(s.id),
          }))}
          trigger={
            <span className={cn(TAB, tabLook(activeMoved))} aria-current={activeMoved ? "page" : undefined}>
              {activeMoved && <active.icon size={16} className="shrink-0" />}
              {activeMoved ? active.label : "More"}
              <ChevronDown size={14} />
            </span>
          }
        />
      )}
    </nav>
  );
}
