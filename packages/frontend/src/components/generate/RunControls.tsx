import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, Dices, Minus, Pencil, Plus, RotateCcw } from "lucide-react";
import { cn } from "../../lib/cn";
import { countHint, countLabel, randomSeed, type CountMode } from "../../lib/requests";
import { ShapeIcon, SIZE_GROUP, useSizePresets } from "../SizeFilter";
import { Input, Picker, ProgressBar, type PickerOption } from "../ui";
import type { ActiveBatch, Sampling } from "../../lib/generate";
import { samplerLabel, samplingLabel } from "../../lib/generateForm";

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-muted mb-1.5">
      {children}
    </label>
  );
}

/** File name without folder or extension, as LoRAs show in the library. */
export function stemOf(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, "");
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

/** A number field with − / + either side. */
function NumberStepper({
  label,
  value,
  onChange,
  step,
  min,
  max,
}: {
  label: string;
  value: number | undefined;
  onChange: (n: number) => void;
  step: number;
  min: number;
  max: number;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const fit = (n: number) => {
    const v = Math.max(min, Math.min(max, n));
    return step >= 1 ? Math.round(v) : Math.round(v * 100) / 100;
  };
  const set = (n: number) => onChange(fit(n));
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex h-9 items-center rounded-lg border border-line">
        <button type="button" aria-label={`Less ${label}`} onClick={() => set((value ?? min) - step)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
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
          className="no-spin w-full min-w-0 bg-transparent text-center tabular-nums text-sm outline-none"
        />
        <button type="button" aria-label={`More ${label}`} onClick={() => set((value ?? min) + step)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * Sampler, scheduler, steps and CFG behind one field that shows them in a
 * line. `value` holds only what the user changed; `defaults` is the
 * Generator's graph, shown for the rest.
 */
export function SamplingControl({
  value,
  defaults,
  samplers,
  schedulers,
  onChange,
  invalid,
}: {
  value: Sampling;
  defaults: Sampling;
  samplers: readonly string[];
  schedulers: readonly string[];
  onChange: (s: Sampling) => void;
  invalid?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const shown = { ...defaults, ...value };
  const changed = Object.keys(value).length > 0;
  const patch = (p: Sampling) => {
    const next = { ...value, ...p };
    // Back at the Generator's own value: no longer a change.
    for (const k of Object.keys(p) as (keyof Sampling)[]) if (next[k] === defaults[k]) delete next[k];
    onChange(next);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const options = (names: readonly string[], current: string | undefined, label: (n: string) => string): PickerOption[] => {
    const list = current && !names.includes(current) ? [current, ...names] : names;
    return list.map((n) => ({ value: n, label: label(n), detail: label(n) !== n ? n : undefined }));
  };
  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <FieldLabel>Sampling</FieldLabel>
      <button
        type="button"
        aria-label="Sampling"
        aria-expanded={open}
        title={invalid ?? samplingLabel(shown)}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "sampling-field flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-canvas px-3 text-left text-sm hover:border-line-strong",
          invalid && "ring-1 ring-red-700",
        )}
      >
        {/* The sampler gives way when space is short; steps and CFG never
            truncate, and drop their words when the field is narrow. */}
        <span className={cn("min-w-0 flex-1 truncate", changed ? "text-neutral-100" : "text-muted")}>
          {shown.sampler ? samplerLabel(shown.sampler) : samplingLabel({ scheduler: shown.scheduler }) || "Default"}
        </span>
        {(shown.steps != null || shown.cfg != null) && (
          <span className="shrink-0 whitespace-nowrap tabular-nums text-muted">
            {shown.steps != null && (
              <>
                {shown.steps}
                <span className="sampling-unit"> steps</span>
              </>
            )}
            {shown.steps != null && shown.cfg != null && <span className="text-faint"> · </span>}
            {shown.cfg != null && (
              <>
                <span className="sampling-unit">CFG </span>
                {shown.cfg}
              </>
            )}
          </span>
        )}
        <ChevronDown size={16} className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-80 max-w-[90vw] space-y-3 rounded-lg border border-line-strong bg-raised p-3 shadow-panel">
          {"sampler" in defaults && (
            <div>
              <FieldLabel>Sampler</FieldLabel>
              <Picker
                aria-label="Sampler"
                value={shown.sampler ?? ""}
                options={options(samplers, shown.sampler, (n) => samplerLabel(n))}
                onChange={(v) => patch({ sampler: v })}
                searchable
                className="w-full"
                side="up"
              />
            </div>
          )}
          {"scheduler" in defaults && (
            <div>
              <FieldLabel>Scheduler</FieldLabel>
              <Picker
                aria-label="Scheduler"
                value={shown.scheduler ?? ""}
                options={options(schedulers, shown.scheduler, (n) => n.replace(/_/g, " "))}
                onChange={(v) => patch({ scheduler: v })}
                className="w-full"
                side="up"
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {"steps" in defaults && (
              <NumberStepper label="Steps" value={shown.steps} onChange={(n) => patch({ steps: n })} step={1} min={1} max={200} />
            )}
            {"cfg" in defaults && (
              <NumberStepper label="CFG" value={shown.cfg} onChange={(n) => patch({ cfg: n })} step={0.5} min={0} max={30} />
            )}
          </div>
          {changed && (
            <button
              type="button"
              onClick={() => onChange({})}
              title={samplingLabel(defaults)}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-neutral-100"
            >
              <RotateCcw size={12} />
              Generator's settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The compact queue card: the running batch, progress, how many wait. */
export function QueueCard({ active, connected }: { active: ActiveBatch[]; connected: boolean }) {
  const shown = active.filter((a) => !a.test);
  if (!shown.length) return null;
  const [head, ...rest] = shown;
  const step = head.progress && head.progress.max ? head.progress.value / head.progress.max : 0;
  const pct = head.requests ? ((head.finished + step) / head.requests) * 100 : 0;
  return (
    <Link
      to={`/generations/${head._id}`}
      aria-label={`Queue: ${head.name}, ${head.finished} of ${head.requests} requests done${rest.length ? `, ${rest.length} more waiting` : ""}`}
      className="block rounded-lg border border-line bg-neutral-950/60 px-3 py-2.5 hover:border-line-strong"
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", connected ? "bg-emerald-400 animate-pulse" : "bg-neutral-500")} />
        <span className="flex-1 truncate text-neutral-100">{head.name}</span>
        <span className="tabular-nums text-xs text-muted">
          {head.finished} / {head.requests}
        </span>
        {!connected && <span className="text-xs text-muted">Paused</span>}
      </div>
      <ProgressBar value={pct} className="mt-2" />
      {rest.length > 0 && (
        <div className="mt-1.5 text-xs text-faint">
          {rest.length} more {rest.length === 1 ? "batch" : "batches"} queued
        </div>
      )}
    </Link>
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
            "shrink-0 rounded-md px-2 text-xs",
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
              title="Later requests count up from this seed"
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
            title="Keep one seed (later requests count up from it)"
            onClick={toFixed}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 text-xs text-muted hover:text-neutral-100"
          >
            Fixed
            {value.value != null && <span className="truncate tabular-nums text-faint">{value.value}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

/** Images (batch size mapped) or Requests, with the "4 × 2" split under it. */
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
  const set = (n: number) => onChange(Math.max(1, Math.min(500, n)));
  const label = mode.kind === "images" ? "Images" : "Requests";
  return (
    <div className={className}>
      <div className="flex items-start gap-2">
        <div>
          <FieldLabel>{label}</FieldLabel>
          <div className="inline-flex h-9 items-center rounded-lg border border-line">
            <button type="button" aria-label="Fewer" onClick={() => set(value - 1)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
              <Minus size={14} />
            </button>
            <input
              type="number"
              aria-label={label}
              value={value}
              min={1}
              max={500}
              onChange={(e) => set(Number(e.target.value) || 1)}
              className="no-spin w-8 bg-transparent text-center tabular-nums text-sm outline-none"
            />
            <button type="button" aria-label="More" onClick={() => set(value + 1)} className="px-1.5 py-2 text-muted hover:text-neutral-100">
              <Plus size={14} />
            </button>
          </div>
        </div>
        {batchSize && (
          <div className="w-[6.5rem] shrink-0">
            <NumberStepper
              label="Batch size"
              value={batchSize.value ?? batchSize.default}
              onChange={(n) => batchSize.onChange(n === batchSize.default ? null : n)}
              step={1}
              min={1}
              max={64}
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const name = custom ?? auto;
  if (editing) {
    const commit = () => {
      const t = draft.trim();
      onChange(t && t !== auto ? t : null);
      setEditing(false);
    };
    return (
      <div>
        <FieldLabel>Batch name</FieldLabel>
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            aria-label="Batch name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          {custom && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(null);
                setEditing(false);
              }}
              className="shrink-0 text-xs text-muted hover:text-neutral-100"
            >
              Use auto name
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <FieldLabel>Batch name</FieldLabel>
      {/* As tall as the fields beside it, so the name lines up with their values. */}
      <div className="flex h-9 items-center gap-2 text-sm">
        <span className="truncate text-neutral-100">{name}</span>
        <button
          type="button"
          aria-label="Rename batch"
          title="Rename"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
          className="rounded p-1 text-muted hover:bg-raised hover:text-neutral-100"
        >
          <Pencil size={13} />
        </button>
      </div>
    </div>
  );
}

