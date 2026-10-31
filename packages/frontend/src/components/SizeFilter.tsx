import { useState } from "react";
import { useSizePresets, type SizePreset } from "../hooks/useSizePresets";
import type { Filters } from "../lib/imageFilter";
import { Input, Picker, type PickerOption } from "./ui";

const CUSTOM = "custom";
export const SIZE_GROUP = { portrait: "Portrait", square: "Square", landscape: "Landscape" } as const;

/** A small outline of the preset's shape, its long side `size` px. */
export function ShapeIcon({ width, height, size = 14 }: { width: number; height: number; size?: number }) {
  const k = width / height;
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-[2px] border-[1.5px] border-current text-muted"
      style={{ width: k >= 1 ? size : Math.round(size * k), height: k >= 1 ? Math.round(size / k) : size }}
    />
  );
}

function sizeOptions(presets: readonly SizePreset[]): PickerOption[] {
  return [
    ...presets.map((p) => ({
      value: p.shape,
      label: p.shape,
      detail: `${p.width}×${p.height}`,
      hint: p.count ? p.count.toLocaleString() : undefined,
      icon: <ShapeIcon width={p.width} height={p.height} />,
      group: SIZE_GROUP[p.orientation],
      keywords: `${p.width}x${p.height} ${p.orientation}`,
      dim: p.count === 0,
    })),
    { value: CUSTOM, label: "Custom", detail: "min / max width and height", group: "Custom" },
  ];
}

function Bounds({
  name,
  min,
  max,
  onChange,
}: {
  name: "width" | "height";
  min: number | undefined;
  max: number | undefined;
  onChange: (min: number | undefined, max: number | undefined) => void;
}) {
  const num = (v: string) => (v ? Number(v) : undefined);
  const title = name === "width" ? "Width" : "Height";
  return (
    <div>
      <label className="block text-xs font-medium text-muted mb-1.5">{title} (min / max)</label>
      <div className="flex gap-2">
        <Input
          type="number"
          aria-label={`Min ${name}`}
          placeholder="min"
          value={min ?? ""}
          onChange={(e) => onChange(num(e.target.value), max)}
        />
        <Input
          type="number"
          aria-label={`Max ${name}`}
          placeholder="max"
          value={max ?? ""}
          onChange={(e) => onChange(min, num(e.target.value))}
        />
      </div>
    </div>
  );
}

/**
 * The gallery's Size filter: size presets, any number of them, matched by
 * shape so upscales count (2:3 covers 832×1216 and 1152×1680), with counts
 * from the library. "Custom…" adds min / max width and height boxes, which
 * apply on top of any presets. Renders grid cells for the filter panel.
 */
export function SizeFilter({ filters, setFilters }: { filters: Filters; setFilters: (f: Filters) => void }) {
  const presets = useSizePresets(filters.quarantined);
  const hasBounds = filters.minW != null || filters.maxW != null || filters.minH != null || filters.maxH != null;
  // Custom stays open while its boxes are empty; bounds alone (an old link) open it too.
  const [customOpen, setCustomOpen] = useState(false);
  const custom = customOpen || hasBounds;

  const toggle = (v: string) => {
    if (v === CUSTOM) {
      setCustomOpen(!custom);
      if (custom) setFilters({ ...filters, minW: undefined, maxW: undefined, minH: undefined, maxH: undefined });
      return;
    }
    const on = filters.shape.includes(v);
    setFilters({ ...filters, shape: on ? filters.shape.filter((s) => s !== v) : [...filters.shape, v] });
  };

  return (
    <>
      <div>
        <label className="block text-xs font-medium text-muted mb-1.5">Size</label>
        <Picker
          aria-label="Size filter"
          value={custom ? [...filters.shape, CUSTOM] : filters.shape}
          onChange={toggle}
          placeholder="Any size"
          options={sizeOptions(presets)}
          searchable
        />
      </div>
      {custom && (
        <>
          <Bounds
            name="width"
            min={filters.minW}
            max={filters.maxW}
            onChange={(minW, maxW) => setFilters({ ...filters, minW, maxW })}
          />
          <Bounds
            name="height"
            min={filters.minH}
            max={filters.maxH}
            onChange={(minH, maxH) => setFilters({ ...filters, minH, maxH })}
          />
        </>
      )}
    </>
  );
}
