import React, { useState } from "react";
import { useLocalPref } from "../../hooks/useLocalPref";
import { TabActionsSlot } from "./TabActions";

type DetailTab = "generation" | "tags";
const DETAIL_TAB_KEY = "imageView:tab";

/**
 * Generation data and tags as two tabs, so neither waits below the other.
 * Generation first: most people come back to an image for its recipe. The
 * last tab picked sticks across images and visits, so a tagging session
 * stays on Tags. An image with no generation data shows its tags alone.
 * Both panels stay mounted (the hidden one display:none): the tags panel
 * owns a running AI job's watch, which must outlive a look at Generation.
 */
export function DetailTabs({
  hasGen,
  tagCount,
  generation,
  tags,
}: {
  hasGen: boolean;
  tagCount: number;
  generation: React.ReactNode;
  tags: React.ReactNode;
}) {
  const [picked, pick] = useLocalPref<DetailTab>(DETAIL_TAB_KEY, "generation", {
    parse: (raw) => (raw === "tags" ? "tags" : "generation"),
  });
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const tab: DetailTab = hasGen ? picked : "tags";
  if (!hasGen) return <>{tags}</>;
  const tabs: { id: DetailTab; label: string; count?: number }[] = [
    { id: "generation", label: "Generation" },
    { id: "tags", label: "Tags", count: tagCount },
  ];
  return (
    <>
      {/* Sticks under the panel header while its tab scrolls. */}
      <div className="sticky top-0 z-10 flex items-center gap-1 pl-2 pr-3 border-b border-line bg-surface">
      <div role="tablist" aria-label="Image details" className="flex gap-1">
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => pick(t.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors ${
                on ? "border-brand-400 text-neutral-50 font-medium" : "border-transparent text-muted hover:text-neutral-100"
              }`}
            >
              {t.label}
              {!!t.count && <span className="text-xs text-faint tabular-nums">{t.count}</span>}
            </button>
          );
        })}
      </div>
      <div ref={setSlot} className="ml-auto flex items-center gap-1" />
      </div>
      {/* Only the shown tab's actions go to the bar; the hidden one's stay
          in its own (hidden) row. */}
      <TabActionsSlot.Provider value={tab === "generation" ? slot : null}>
        <div role="tabpanel" hidden={tab !== "generation"}>{generation}</div>
      </TabActionsSlot.Provider>
      <TabActionsSlot.Provider value={tab === "tags" ? slot : null}>
        <div role="tabpanel" hidden={tab !== "tags"}>{tags}</div>
      </TabActionsSlot.Provider>
    </>
  );
}
