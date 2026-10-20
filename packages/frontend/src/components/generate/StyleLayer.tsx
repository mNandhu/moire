import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Button, Card, Input } from "../ui";
import { Dialog } from "../ui/Dialog";
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
import { useToast } from "../Toasts";
import { ExpandButton } from "./Layers";
import { stemOf } from "./RunControls";

const NONE = "\u0000none";
const NEW = "\u0000new";
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
  open,
  onClose,
  lora,
  preset,
  initialText,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  lora: string;
  preset: LoraPreset | null;
  initialText: string;
  onSaved: (p: LoraPreset | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [strength, setStrength] = useState("");
  const { data: words } = useLoraWords(open ? lora : null);
  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? "");
    setText(preset?.text ?? initialText);
    setStrength(preset?.strength != null ? String(preset.strength) : "");
  }, [open, preset, initialText]);
  const done = (p: LoraPreset | null) => {
    void qc.invalidateQueries({ queryKey: LORA_PRESETS_KEY });
    onSaved(p);
    onClose();
  };
  const parsed = strength.trim() === "" ? null : Number(strength);
  const badStrength = parsed !== null && (!Number.isFinite(parsed) || parsed < -2 || parsed > 2);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, text, strength: parsed };
      return preset ? updateLoraPreset(preset._id, body) : createLoraPreset({ lora, ...body });
    },
    onSuccess: done,
    onError: (e) => toast.push(e.message, "error"),
  });
  const remove = useMutation({
    mutationFn: () => deleteLoraPreset(preset!._id),
    onSuccess: () => done(null),
    onError: (e) => toast.push(e.message, "error"),
  });
  const offer = (words ?? []).filter((w) => !hasWord(text, toPromptText([w.word])));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-baseline gap-2.5">
          {preset ? "Edit preset" : "New preset"}
          <span className="truncate font-mono text-xs font-normal text-muted">{stemOf(lora)}</span>
        </span>
      }
      footer={
        <div className="flex w-full items-center gap-2">
          {preset && (
            <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending} className="text-red-300">
              Delete
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!name.trim() || badStrength || save.isPending}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Input aria-label="Preset name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          aria-label="Activation words"
          placeholder="Activation words"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-2 font-mono text-xs text-neutral-100 outline-none placeholder:text-faint focus:border-brand-600/60"
        />
        <label className="flex items-center gap-2.5 text-xs text-muted">
          Default strength
          <input
            type="number"
            step={0.05}
            min={-2}
            max={2}
            value={strength}
            placeholder="Keep"
            onChange={(e) => setStrength(e.target.value)}
            className={cn(
              "w-20 rounded-md border bg-raised px-2 py-1 text-right tabular-nums text-xs text-neutral-100 placeholder:text-faint",
              badStrength ? "border-red-700" : "border-line",
            )}
          />
        </label>
        {offer.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted">Suggested</div>
            <div className="flex flex-wrap gap-1.5">
              {offer.map((w) => (
                <button
                  key={w.word}
                  type="button"
                  onClick={() => setText((t) => (t.trim() ? `${t.trim().replace(/,$/, "")}, ` : "") + toPromptText([w.word]))}
                  title={[
                    w.sources.includes("file") ? "In the LoRA's training tags" : null,
                    w.prompts ? `In ${w.prompts} of your prompts that used it` : null,
                  ]
                    .filter(Boolean)
                    .join("; ")}
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
      </div>
    </Dialog>
  );
}

/** One style LoRA: its preset, the words it adds, its strength. */
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
  const [dialog, setDialog] = useState<"edit" | "new" | null>(null);
  const mine = presetsOf(lora.name, presets);
  const current = lora.preset ? (mine.find((p) => p._id === lora.preset!.id) ?? null) : null;
  const deleted = !!lora.preset && !current && !!presets;
  const words = loraWords(lora, presets);
  const opts: PickerOption[] = [
    { value: NONE, label: "None", detail: "LoRA only" },
    ...mine.map((p) => ({ value: p._id, label: p.name, detail: p.text, keywords: p.text })),
    ...(deleted ? [{ value: lora.preset!.id, label: "Deleted preset", dim: true }] : []),
    { value: NEW, label: "New preset" },
  ];
  const pick = (p: LoraPreset) =>
    onChange({ ...lora, preset: { id: p._id, text: p.text }, strength: p.strength ?? lora.strength });
  return (
    <div className="flex items-center gap-2.5 border-t border-line py-1.5 first:border-t-0">
      <span
        className={cn("w-40 shrink-0 truncate font-mono text-xs", invalid ? "text-red-300" : "text-neutral-100")}
        title={invalid ? `${lora.name}: not installed in ComfyUI` : lora.name}
      >
        {stemOf(lora.name)}
      </span>
      <div className="w-36 shrink-0">
        <Picker
          aria-label={`${stemOf(lora.name)} preset`}
          value={lora.preset?.id ?? NONE}
          options={opts}
          placeholder={mine.length ? "None" : "No preset yet"}
          onChange={(v) => {
            if (v === NEW) setDialog("new");
            else if (v === NONE) onChange({ ...lora, preset: null });
            else {
              const p = mine.find((x) => x._id === v);
              if (p) pick(p);
            }
          }}
          className="w-full"
        />
      </div>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={words || undefined}>
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
      <input
        type="number"
        step={0.05}
        min={-2}
        max={2}
        value={lora.strength}
        aria-label={`${stemOf(lora.name)} strength value`}
        onChange={(e) => onChange({ ...lora, strength: Number(e.target.value) })}
        className="w-14 shrink-0 rounded-md border border-line bg-raised px-1.5 py-0.5 text-right tabular-nums text-xs"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setDialog(current ? "edit" : "new")}
        title={current ? "Edit this preset" : "Make a preset for this LoRA"}
      >
        {current ? "Edit" : "New"}
      </Button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${stemOf(lora.name)}`}
        className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
      >
        <X size={14} />
      </button>
      <LoraPresetDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        lora={lora.name}
        preset={dialog === "edit" ? current : null}
        initialText={dialog === "new" ? words : ""}
        onSaved={(p) => {
          if (p) pick(p);
          else if (dialog === "edit") onChange({ ...lora, preset: null });
        }}
      />
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
      return `${stemOf(l.name)} ${l.strength}${p ? ` ${p.name}` : ""}`;
    })
    .join(" · ");
  return (
    <Card className="px-3.5 py-2">
      <div className="flex min-h-[2.25rem] items-center gap-3">
        <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Style</span>
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-200" title={summary || undefined}>
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
