import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Dices, Minus, Plus } from "lucide-react";
import { cn } from "../../lib/cn";
import { countHint, countLabel, randomSeed, type CountMode } from "../../lib/requests";
import { ShapeIcon, SIZE_GROUP } from "../SizeFilter";
import { InlineRename } from "../InlineRename";
import { useSizePresets } from "../../hooks/useSizePresets";
import { Picker, Tooltip, type PickerOption } from "../ui";
import { PER_REQUEST_MAX } from "../../lib/generationLimits";
import { stemOf } from "../../lib/modelNames";

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-muted mb-1.5">
      {children}
    </label>
  );
}

export function CheckpointPicker({
  value,
  options,
  onChange,
  invalid,
  disabled,
}: {
  value: string | null;
  options: readonly string[];
  onChange: (v: string) => void;
  invalid?: string | null;
  disabled?: boolean;
}) {
  const opts: PickerOption[] = options.map((n) => ({ value: n, label: stemOf(n), detail: n.includes("/") ? n : undefined }));
  return (
    <div>
      <FieldLabel>Checkpoint</FieldLabel>
      <div title={invalid ?? undefined} className={cn(invalid && "rounded-lg ring-1 ring-red-700")}>
        <Picker
          aria-label="Checkpoint"
          value={value ?? ""}
          options={opts}
          onChange={onChange}
          placeholder="Choose a checkpoint"
          searchable
          disabled={disabled}
          className="w-full"
          side="up"
        />
      </div>
    </div>
  );
}

/** A value the workflow sets itself: shown, not editable, with a tip on why
 * and where to change that. */
export function FixedValue({
  label,
  value,
  why,
  fix,
}: {
  label: string;
  value: React.ReactNode;
  why: string;
  /** Where to make it Moiré's: a link to the workflow's setup. */
  fix?: { text: string; to: string };
}) {
  return (
    <div className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <Tooltip
        className="w-full"
        content={
          <div className="space-y-1.5">
            <p>{why}</p>
            {fix && (
              <Link to={fix.to} className="text-brand-300 hover:text-brand-200">
                {fix.text}
              </Link>
            )}
          </div>
        }
      >
        <span
          tabIndex={0}
          className="flex h-9 w-full min-w-0 items-center truncate rounded-lg border border-dashed border-line-strong px-3 text-sm text-muted outline-none focus-visible:border-brand-500/70"
        >
          <span className="truncate">{value ?? "Set in the workflow"}</span>
        </span>
      </Tooltip>
    </div>
  );
}

/** A number field with - / + either side; `compact` fits about three digits. */
export function NumberStepper({
  label,
  value,
  onChange,
  step,
  min,
  max,
  compact,
}: {
  label: string;
  value: number | undefined;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
  compact?: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const fit = (n: number) => {
    const v = Math.max(min, Math.min(max, n));
    return step >= 1 ? Math.round(v) : Math.round(v * 100) / 100;
  };
  const set = (n: number) => onChange(fit(n));
  // Steps and counts are "fewer", a CFG scale "less".
  const less = step >= 1 ? "Fewer" : "Less";
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className={cn("h-9 items-center rounded-lg border border-line", compact ? "inline-flex" : "flex")}>
        <button type="button" aria-label={`${less} ${label}`} onClick={() => set((value ?? min) - step)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
          <Minus size={14} />
        </button>
        <input
          type="number"
          aria-label={label}
          value={typed ?? value ?? ""}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            // Kept as typed, taken at once when in range: the popover can close
            // (and unmount this) before a blur would arrive.
            const raw = e.target.value;
            setTyped(raw);
            const n = Number(raw);
            // Only a value that needs no rounding, so what shows is what's kept.
            if (raw.trim() !== "" && Number.isFinite(n) && fit(n) === n) set(n);
          }}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className={cn("no-spin bg-transparent text-center tabular-nums text-sm outline-none", compact ? "w-8" : "w-full min-w-0")}
        />
        <button type="button" aria-label={`More ${label}`} onClick={() => set((value ?? min) + step)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

export type Size = { width: number; height: number };

/** Single pick of the gallery's size presets (shape + its usual pixels). */
export function SizePicker({ value, onChange }: { value: Size; onChange: (s: Size) => void }) {
  const presets = useSizePresets();
  const key = `${value.width}x${value.height}`;
  const opts: PickerOption[] = presets.map((p) => ({
    value: `${p.width}x${p.height}`,
    label: p.shape,
    detail: `${p.width}×${p.height}`,
    hint: p.count ? p.count.toLocaleString() : undefined,
    icon: <ShapeIcon width={p.width} height={p.height} />,
    group: SIZE_GROUP[p.orientation],
    keywords: `${p.width}x${p.height} ${p.orientation}`,
  }));
  if (!opts.some((o) => o.value === key)) {
    opts.unshift({ value: key, label: `${value.width}×${value.height}`, icon: <ShapeIcon {...value} /> });
  }
  return (
    <div>
      <FieldLabel>Size</FieldLabel>
      <Picker
        aria-label="Size"
        value={key}
        options={opts}
        onChange={(v) => {
          const [w, h] = v.split("x").map(Number);
          onChange({ width: w, height: h });
        }}
        searchable
        className="w-full"
        side="up"
      />
    </div>
  );
}

export type SeedValue = { mode: "random" | "fixed"; value: number | null };

export function SeedControl({ value, onChange }: { value: SeedValue; onChange: (s: SeedValue) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fixed = value.mode === "fixed";
  // One field: Random on the left, and the fixed seed itself on the right, so
  // the number gets the whole remaining width instead of a sliver beside a
  // two-button toggle. Choosing Fixed (or clicking the number) edits it.
  // On Random the two halves split the field evenly: a fresh form has no
  // seed to show, and a lone "Fixed" at the left of a wide half read as empty.
  const toFixed = () => {
    if (!fixed) onChange({ mode: "fixed", value: value.value ?? randomSeed() });
    requestAnimationFrame(() => inputRef.current?.select());
  };
  return (
    <div>
      <FieldLabel htmlFor="seed-value">Seed</FieldLabel>
      <div className="flex h-9 items-stretch gap-0.5 rounded-lg border border-line bg-canvas p-0.5 focus-within:border-brand-500/70 transition-colors">
        <button
          type="button"
          aria-pressed={!fixed}
          title="A new seed for every request"
          onClick={() => onChange({ mode: "random", value: value.value })}
          className={cn(
            "rounded-md px-2 text-xs",
            fixed ? "shrink-0" : "flex-1",
            !fixed ? "bg-brand-600 text-white" : "text-muted hover:text-neutral-100",
          )}
        >
          Random
        </button>
        {fixed ? (
          <div className="flex min-w-0 flex-1 items-center rounded-md bg-brand-600/15 ring-1 ring-inset ring-brand-500/50">
            <input
              ref={inputRef}
              id="seed-value"
              type="number"
              inputMode="numeric"
              aria-label="Seed"
              title="Later runs count up from this seed"
              value={value.value ?? ""}
              placeholder="Seed"
              onChange={(e) => onChange({ mode: "fixed", value: e.target.value ? Number(e.target.value) : null })}
              className="no-spin h-full w-full min-w-0 bg-transparent pl-2.5 text-sm tabular-nums text-neutral-100 outline-none placeholder:text-faint"
            />
            <button
              type="button"
              aria-label="New random seed"
              title="New random seed"
              onClick={() => onChange({ mode: "fixed", value: randomSeed() })}
              className="shrink-0 rounded-md p-1.5 text-muted hover:text-neutral-100"
            >
              <Dices size={15} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-pressed={false}
            title="Keep one seed (later runs count up from it)"
            onClick={toFixed}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-md px-2.5 text-xs text-muted hover:text-neutral-100"
          >
            Fixed
            {value.value != null && <span className="truncate tabular-nums text-faint">{value.value}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

/** The most images or runs one batch queues. */
const COUNT_MAX = 500;

/** Images (batch size mapped), with the "2 runs of 2" split under it, or Runs. */
export function CountStepper({
  value,
  onChange,
  mode,
  batchSize,
  className,
}: {
  value: number;
  onChange: (n: number) => void;
  mode: CountMode;
  /** Images per run, set here when the Generator takes it; null is the setting's. */
  batchSize?: { value: number | null; default: number; onChange: (n: number | null) => void } | null;
  className?: string;
}) {
  const label = mode.kind === "images" ? "Images" : "Runs";
  return (
    <div className={className}>
      <div className="flex items-start gap-2">
        <NumberStepper label={label} value={value} onChange={onChange} step={1} min={1} max={COUNT_MAX} compact />
        {batchSize && (
          <div className="w-[6.5rem] shrink-0">
            <NumberStepper
              label="Batch size"
              value={batchSize.value ?? batchSize.default}
              onChange={(n) => batchSize.onChange(n === batchSize.default ? null : n)}
              step={1}
              min={1}
              max={PER_REQUEST_MAX}
            />
          </div>
        )}
      </div>
      <div className="mt-1 w-fit whitespace-nowrap text-xs tabular-nums text-muted" title={countHint(value, mode)}>
        {countLabel(value, mode)}
      </div>
    </div>
  );
}

/** The batch name as text with a pencil; editing stops the auto name. */
export function BatchName({
  auto,
  custom,
  onChange,
}: {
  auto: string;
  custom: string | null;
  onChange: (name: string | null) => void;
}) {
  return (
    <div>
      <FieldLabel>Batch name</FieldLabel>
      {/* As tall as the fields beside it, so the name lines up with their values. */}
      <InlineRename
        value={custom ?? auto}
        label="batch"
        onCommit={(t) => onChange(t && t !== auto ? t : null)}
        reset={custom ? { label: "Use auto name", onReset: () => onChange(null) } : null}
        className="h-9 text-sm text-neutral-100"
        iconSize={13}
      />
    </div>
  );
}
