import { useState } from "react";
import { Picker } from "@/components/ui/Picker";
import { DateField } from "@/components/ui/DateField";
import type { Filters } from "@/features/images/lib/imageFilter";
import { MADE_PRESETS, presetOf, presetRange, rangeDays, rangeOf, type MadePreset } from "@/features/images/lib/madeRange";

const ANY = "";
const CUSTOM = "custom";
const OPTIONS = [
  { value: ANY, label: "Any time" },
  ...MADE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  { value: CUSTOM, label: "Custom range", detail: "from / to" },
];

/**
 * The gallery's Made filter: when the images were made (file time, the
 * feed's order). A preset, or a custom From / To of whole days (either end
 * may be open). Renders grid cells for the filter panel, like SizeFilter.
 */
export function MadeFilter({ filters, setFilters }: { filters: Filters; setFilters: (f: Filters) => void }) {
  const preset = presetOf(filters);
  const hasRange = filters.madeFrom != null || filters.madeTo != null;
  // Custom stays open while its days are empty; a range no preset names
  // (a calendar day from Overview, an old link) opens it too.
  const [customOpen, setCustomOpen] = useState(false);
  // The range cleared from outside (Back, Clear filters, its chip): Custom
  // closes with it rather than stay open over nothing.
  const [hadRange, setHadRange] = useState(hasRange);
  if (hadRange !== hasRange) {
    setHadRange(hasRange);
    if (!hasRange) setCustomOpen(false);
  }
  const custom = customOpen || (hasRange && !preset);
  const { from, to } = rangeDays(filters);

  const choose = (v: string) => {
    if (v === CUSTOM) {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    const range = v === ANY ? { madeFrom: undefined, madeTo: undefined } : presetRange(v as MadePreset);
    setFilters({ ...filters, madeFrom: undefined, madeTo: undefined, ...range });
  };
  const setDays = (f: Date | null, t: Date | null) => {
    setCustomOpen(true);
    setFilters({ ...filters, ...rangeOf(f, t) });
  };
  const today = new Date();

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-muted mb-1.5">Made</label>
        <Picker
          aria-label="Made filter"
          value={custom ? CUSTOM : (preset ?? ANY)}
          onChange={choose}
          options={OPTIONS}
        />
      </div>
      {custom && (
        <>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">From</label>
            <DateField aria-label="Made from" value={from} max={to ?? today} onChange={(d) => setDays(d, to)} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted mb-1.5">To</label>
            <DateField aria-label="Made to" value={to} max={today} onChange={(d) => setDays(from, d)} />
          </div>
        </>
      )}
    </>
  );
}
