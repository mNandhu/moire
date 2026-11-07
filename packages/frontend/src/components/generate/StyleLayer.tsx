import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button, Card } from "../ui";
import { Picker, type PickerOption } from "../ui/Picker";
import { cn } from "../../lib/cn";
import {
  LORA_PRESETS_KEY,
  createLoraPreset,
  deleteLoraPreset,
  updateLoraPreset,
  useLoraWords,
  type LoraPreset,
  type StyleLora,
} from "../../lib/generate";
import { loraWords } from "../../lib/generateForm";
import { toPromptText } from "../../lib/tags";
import { PresetDialogShell } from "./PresetDialogShell";
import { PresetPicker } from "./PresetPicker";
import { ExpandButton } from "./Layers";
import { NumberStepper } from "./fields";
import { stemOf } from "../../lib/modelNames";
import { Tooltip } from "../ui/Tooltip";

const DEFAULT_STRENGTH = 0.7;

/** A LoRA's presets, the most recently edited first. */
function presetsOf(name: string, all: readonly LoraPreset[] | undefined): LoraPreset[] {
  const stem = stemOf(name);
  return (all ?? []).filter((p) => p.stem === stem).sort((a, b) => b.updated_at - a.updated_at);
}

/** Words already in a comma list, compared loosely. */
function hasWord(text: string, word: string): boolean {
  const w = word.trim().toLowerCase();
  return text.split(",").some((x) => x.trim().toLowerCase() === w);
}

/** Create or edit one LoRA's activation preset, with suggested words. */
function LoraPresetDialog({
  onClose,
  lora,
  preset,
  initialText,
  onSaved,
}: {
  onClose: () => void;
  lora: string;
  preset: LoraPreset | null;
  initialText: string;
  onSaved: (p: LoraPreset | null) => void;
}) {
  const [name, setName] = useState(preset?.name ?? "");
  const [text, setText] = useState(preset?.text ?? initialText);
  const [strength, setStrength] = useState(preset?.strength != null ? String(preset.strength) : "");
  const { data: words, isPending: wordsLoading } = useLoraWords(lora);
  const parsed = strength.trim() === "" ? null : Number(strength);
  const badStrength = parsed !== null && (!Number.isFinite(parsed) || parsed < -2 || parsed > 2);
  const offer = (words ?? []).filter((w) => !hasWord(text, toPromptText([w.word])));
  return (
    <PresetDialogShell
      title={
        <span className="flex items-baseline gap-2.5">
          {preset ? "Edit preset" : "New preset"}
          <span className="truncate font-mono text-xs font-normal text-muted">{stemOf(lora)}</span>
        </span>
      }
      editing={!!preset}
      name={name}
      onName={setName}
      canSave={!badStrength}
      queryKey={LORA_PRESETS_KEY}
      save={() => {
        const body = { name, text, strength: parsed };
        return preset ? updateLoraPreset(preset._id, body) : createLoraPreset({ lora, ...body });
      }}
      remove={() => deleteLoraPreset(preset!._id)}
      onClose={onClose}
      onSaved={onSaved}
    >
        <textarea
          aria-label="Activation words"
          placeholder="Activation words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-2 font-mono text-xs text-neutral-100 outline-none placeholder:text-faint focus:border-brand-600/60"
        />
        <label
          className="flex items-center gap-2.5 text-xs text-muted"
        >
          Default strength
          <input
            type="number"
            step={0.05}
            min={-2}
            max={2}
            value={strength}
            placeholder="Not set"
            onChange={(e) => setStrength(e.target.value)}
            className={cn(
              "no-spin w-20 rounded-md border bg-raised px-2 py-1 text-center tabular-nums text-xs text-neutral-100 placeholder:text-faint",
              badStrength ? "border-red-700" : "border-line",
            )}
          />
        </label>
        {wordsLoading && (
          // The words are read from the LoRA file and the library: a moment.
          <div aria-busy="true" aria-label="Loading suggestions">
            <div className="mb-1.5 text-xs font-medium text-muted">Suggested</div>
            <div className="flex flex-wrap gap-1.5">
              {[64, 92, 52, 80].map((w) => (
                <span key={w} style={{ width: w }} className="h-6 animate-pulse rounded-full border border-line bg-raised" />
              ))}
            </div>
          </div>
        )}
        {offer.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Suggested</div>
            <div className="flex flex-wrap gap-1.5">
              {offer.map((w) => (
                <button
                  key={w.word}
                  type="button"
                  onClick={() => setText((t) => (t.trim() ? `${t.trim().replace(/,$/, "")}, ` : "") + toPromptText([w.word]))}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-raised px-2.5 py-0.5 text-sm text-neutral-200 hover:border-brand-500 hover:text-white"
                >
                  <Plus size={12} />
                  {w.word}
                  <span className="text-2xs text-faint">
                    {[w.sources.includes("file") ? "file" : null, w.prompts ? `library ${w.prompts}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
    </PresetDialogShell>
  );
}

/** One style LoRA: on or off, its preset, the words it adds, its strength. */
function LoraRow({
  lora,
  onChange,
  onRemove,
  presets,
  invalid,
}: {
  lora: StyleLora;
  onChange: (l: StyleLora) => void;
  onRemove: () => void;
  presets: readonly LoraPreset[] | undefined;
  invalid: boolean;
}) {
  // Edit holds the preset it opened on: the list refetching without it
  // must not turn the dialog into a New one.
  const [dialog, setDialog] = useState<{ edit: LoraPreset } | "new" | null>(null);
  const mine = presetsOf(lora.name, presets);
  const current = lora.preset ? (mine.find((p) => p._id === lora.preset!.id) ?? null) : null;
  const words = loraWords(lora, presets);
  const pick = (p: LoraPreset) =>
    onChange({ ...lora, preset: { id: p._id, text: p.text }, strength: p.strength ?? lora.strength });
  const on = !lora.off;
  const stem = stemOf(lora.name);
  const toggle = () => onChange({ ...lora, off: on || undefined });
  const name = (
    <Tooltip content={invalid ? "Not installed in ComfyUI" : undefined} bubble className="w-40 shrink-0">
      <span className={cn("w-full truncate font-mono text-xs", invalid ? "text-red-300" : "text-neutral-100")}>{stem}</span>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-2.5 border-t border-line py-1.5 first:border-t-0">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`Use ${stem}`}
        onClick={toggle}
        className={cn(
          "relative h-4 w-7 shrink-0 rounded-full transition-colors",
          on ? "bg-brand-500" : "bg-neutral-700 hover:bg-neutral-600",
        )}
      >
        <span
          className={cn(
            "absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform",
            on ? "translate-x-3.5" : "translate-x-0.5",
          )}
        />
      </button>
      {/* Off, it stays as set but isn't sent: dimmed, still editable. */}
      <div className={cn("flex min-w-0 flex-1 items-center gap-2.5 transition-opacity", !on && "opacity-40")}>
      {name}
      {/* The preset and its Edit side by side, the words it adds after. */}
      <div className="flex w-48 shrink-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <PresetPicker
            aria-label={`${stemOf(lora.name)} preset`}
            presets={mine}
            loaded={!!presets}
            value={lora.preset?.id}
            onPick={(p) => (p ? pick(p) : onChange({ ...lora, preset: null }))}
            onNew={() => setDialog("new")}
            placeholder={mine.length ? "No preset" : "No preset yet"}
            noneLabel="No preset"
            noneDetail="LoRA only"
            showText
          />
        </div>
        {/* New is in the picker; Edit only once one is picked. */}
        {current && (
          <Button size="sm" variant="ghost" onClick={() => current && setDialog({ edit: current })}>
            Edit
          </Button>
        )}
      </div>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
        {words}
      </span>
      <input
        type="range"
        min={0}
        max={1.5}
        step={0.05}
        value={Math.min(Math.max(lora.strength, 0), 1.5)}
        onChange={(e) => onChange({ ...lora, strength: Number(e.target.value) })}
        aria-label={`${stemOf(lora.name)} strength`}
        className="w-24 shrink-0 accent-brand-500"
      />
      <div className="shrink-0">
        <NumberStepper
          label={`${stemOf(lora.name)} strength value`}
          value={lora.strength}
          onChange={(n) => onChange({ ...lora, strength: n })}
          step={0.05}
          min={-2}
          max={2}
          small
          hideLabel
        />
      </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${stemOf(lora.name)}`}
        className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
      >
        <X size={14} />
      </button>
      {dialog && (
        <LoraPresetDialog
          onClose={() => setDialog(null)}
          lora={lora.name}
          preset={dialog === "new" ? null : dialog.edit}
          initialText={dialog === "new" ? words : ""}
          onSaved={(p) => {
            if (p) pick(p);
            else if (dialog !== "new") onChange({ ...lora, preset: null });
          }}
        />
      )}
    </div>
  );
}

/**
 * The Style layer: the style LoRAs, each with an activation preset (the words
 * it wants in the prompt, added where this layer sits) and a strength. Folds
 * to one line.
 */
export function StyleLayer({
  value,
  onChange,
  installed,
  usage,
  invalid,
  presets,
}: {
  value: StyleLora[];
  onChange: (v: StyleLora[]) => void;
  installed: readonly string[];
  /** Library use per stem, to rank the picker. */
  usage: ReadonlyMap<string, number>;
  /** LoRA names ComfyUI rejected. */
  invalid: ReadonlySet<string>;
  presets: readonly LoraPreset[] | undefined;
}) {
  const [open, setOpen] = useState(true);
  const opts: PickerOption[] = useMemo(() => {
    const taken = new Set(value.map((l) => l.name));
    return installed
      .filter((n) => !taken.has(n))
      .map((n) => ({
        value: n,
        label: stemOf(n),
        detail: n.includes("/") ? n : undefined,
        hint: usage.get(stemOf(n)) ? usage.get(stemOf(n))!.toLocaleString() : undefined,
      }))
      .sort((a, b) => (usage.get(stemOf(b.value)) ?? 0) - (usage.get(stemOf(a.value)) ?? 0));
  }, [installed, usage, value]);
  const add = (name: string) => {
    const p = presetsOf(name, presets)[0];
    onChange([
      ...value,
      { name, strength: p?.strength ?? DEFAULT_STRENGTH, preset: p ? { id: p._id, text: p.text } : null },
    ]);
    setOpen(true);
  };
  const summary = value
    .map((l) => {
      const p = l.preset ? presetsOf(l.name, presets).find((x) => x._id === l.preset!.id) : null;
      return l.off ? `${stemOf(l.name)} off` : `${stemOf(l.name)} ${l.strength}${p ? ` ${p.name}` : ""}`;
    })
    .join(" · ");
  return (
    <Card className="px-3.5 py-2">
      <div className="flex min-h-[2.25rem] items-center gap-3">
        <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Style</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
          {open || !value.length ? (
            <span className="text-xs text-muted">
              {value.length ? `${value.length} ${value.length === 1 ? "LoRA" : "LoRAs"}` : "No style LoRAs"}
            </span>
          ) : (
            summary
          )}
        </span>
        <Picker
          aria-label="Add LoRA"
          value=""
          options={opts}
          onChange={add}
          searchable
          align="right"
          trigger={() => (
            <span className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-line hover:text-neutral-100">
              <Plus size={14} /> LoRA
            </span>
          )}
        />
        {value.length > 0 && <ExpandButton open={open} onToggle={() => setOpen((v) => !v)} />}
      </div>
      {open && value.length > 0 && (
        <div className="mt-1.5 border-t border-line pt-0.5">
          {value.map((l, i) => (
            <LoraRow
              key={l.name}
              lora={l}
              presets={presets}
              invalid={invalid.has(l.name)}
              onChange={(next) => onChange(value.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(value.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
