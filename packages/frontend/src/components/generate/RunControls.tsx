import { useState } from "react";
import { Dices, Minus, Pencil, Plus } from "lucide-react";
import { cn } from "../../lib/cn";
import { countLabel, randomSeed, type CountMode } from "../../lib/requests";
import { ShapeIcon, SIZE_GROUP, useSizePresets } from "../SizeFilter";
import { Input, Picker, type PickerOption } from "../ui";

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

