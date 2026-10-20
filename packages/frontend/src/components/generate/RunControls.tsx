import { useMemo, useState } from "react";
import { Dices, Minus, Pencil, Plus, X } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../lib/cn";
import type { ActiveBatch, LoraPick } from "../../lib/generate";
import { countLabel, randomSeed, type CountMode } from "../../lib/requests";
import { ShapeIcon, SIZE_GROUP, useSizePresets } from "../SizeFilter";
import { Input, Picker, ProgressBar, type PickerOption } from "../ui";

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
        />
      </div>
    </div>
  );
}

/** Style LoRAs: a list beside Checkpoint, each with a strength. */
export function StyleLoras({
  value,
  onChange,
  installed,
  usage,
  invalid,
}: {
  value: LoraPick[];
  onChange: (v: LoraPick[]) => void;
  installed: readonly string[];
  /** Library use per stem, to rank the picker. */
  usage: ReadonlyMap<string, number>;
  /** LoRA names ComfyUI rejected. */
  invalid: ReadonlySet<string>;
}) {
  const taken = new Set(value.map((l) => l.name));
  const opts: PickerOption[] = useMemo(
    () =>
      installed
        .filter((n) => !taken.has(n))
        .map((n) => ({
          value: n,
          label: stemOf(n),
          detail: n.includes("/") ? n : undefined,
          hint: usage.get(stemOf(n)) ? usage.get(stemOf(n))!.toLocaleString() : undefined,
        }))
        .sort((a, b) => (usage.get(stemOf(b.value)) ?? 0) - (usage.get(stemOf(a.value)) ?? 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installed, usage, value],
  );
  return (
    <div>
      <FieldLabel>Style LoRAs</FieldLabel>
      <div className="space-y-1.5">
        {value.map((l, i) => (
          <div
            key={l.name}
            className={cn(
              "flex items-center gap-2 rounded-lg border bg-neutral-950/50 px-2.5 py-1.5 text-sm",
              invalid.has(l.name) ? "border-red-700" : "border-line",
            )}
            title={invalid.has(l.name) ? "Not installed in ComfyUI" : l.name}
          >
            <span className="flex-1 truncate font-mono text-xs text-neutral-100">{stemOf(l.name)}</span>
            <input
              type="number"
              step={0.05}
              min={-2}
              max={2}
              value={l.strength}
              aria-label={`${stemOf(l.name)} strength`}
              onChange={(e) =>
                onChange(value.map((x, j) => (j === i ? { ...x, strength: Number(e.target.value) } : x)))
              }
              className="w-16 rounded-md border border-line bg-raised px-1.5 py-0.5 text-right tabular-nums text-xs"
            />
            <button
              type="button"
              aria-label={`Remove ${stemOf(l.name)}`}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="rounded p-0.5 text-muted hover:bg-line hover:text-neutral-100"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <Picker
          aria-label="Add LoRA"
          value=""
          options={opts}
          onChange={(n) => onChange([...value, { name: n, strength: 0.7 }])}
          placeholder="Add LoRA"
          searchable
          className="w-full"
        />
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
      />
    </div>
  );
}

export type SeedValue = { mode: "random" | "fixed"; value: number | null };

export function SeedControl({ value, onChange }: { value: SeedValue; onChange: (s: SeedValue) => void }) {
  return (
    <div>
      <FieldLabel>Seed</FieldLabel>
      <div className="flex gap-2">
        <div role="radiogroup" aria-label="Seed mode" className="inline-flex rounded-lg border border-line p-0.5">
          {(["random", "fixed"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={value.mode === m}
              onClick={() => onChange({ mode: m, value: m === "fixed" ? (value.value ?? randomSeed()) : value.value })}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs capitalize",
                value.mode === m ? "bg-brand-600 text-white" : "text-muted hover:text-neutral-100",
              )}
            >
              {m}
            </button>
          ))}
        </div>
        {value.mode === "fixed" && (
          <div className="flex flex-1 items-center gap-1">
            <Input
              type="number"
              aria-label="Seed"
              title="Later requests count up from this seed"
              value={value.value ?? ""}
              onChange={(e) => onChange({ mode: "fixed", value: e.target.value ? Number(e.target.value) : null })}
              className="tabular-nums"
            />
            <button
              type="button"
              aria-label="New random seed"
              title="New random seed"
              onClick={() => onChange({ mode: "fixed", value: randomSeed() })}
              className="rounded-md p-2 text-muted hover:bg-raised hover:text-neutral-100"
            >
              <Dices size={16} />
            </button>
          </div>
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
}: {
  value: number;
  onChange: (n: number) => void;
  mode: CountMode;
}) {
  const set = (n: number) => onChange(Math.max(1, Math.min(500, n)));
  return (
    <div>
      <FieldLabel>{mode.kind === "images" ? "Images" : "Requests"}</FieldLabel>
      <div className="flex items-center gap-3">
        <div className="inline-flex items-center rounded-lg border border-line">
          <button type="button" aria-label="Fewer" onClick={() => set(value - 1)} className="p-2 text-muted hover:text-neutral-100">
            <Minus size={14} />
          </button>
          <input
            type="number"
            aria-label={mode.kind === "images" ? "Images" : "Requests"}
            value={value}
            min={1}
            max={500}
            onChange={(e) => set(Number(e.target.value) || 1)}
            className="w-12 bg-transparent text-center tabular-nums text-sm outline-none"
          />
          <button type="button" aria-label="More" onClick={() => set(value + 1)} className="p-2 text-muted hover:text-neutral-100">
            <Plus size={14} />
          </button>
        </div>
        <span
          className="text-xs tabular-nums text-muted"
          title={mode.kind === "images" ? "Requests × images per request" : undefined}
        >
          {countLabel(value, mode)}
        </span>
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
      <div className="flex items-center gap-2 text-sm">
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

