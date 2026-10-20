import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus, Sparkles, TextCursorInput, UserRound, X, Bookmark } from "lucide-react";
import { Button, Card, Input } from "../ui";
import { Dialog } from "../ui/Dialog";
import { Picker, type PickerOption } from "../ui/Picker";
import { cn } from "../../lib/cn";
import {
  PRESETS_KEY,
  createPreset,
  deletePreset,
  updatePreset,
  type Preset,
} from "../../lib/generate";
import { presetText, type AddedKind, type PresetRef } from "../../lib/generateForm";
import { useToast } from "../Toasts";

const NONE = "\u0000none";
const NEW = "\u0000new";

/** A one-line layer: label, controls, and an optional remove button. */
export function LayerRow({
  label,
  children,
  onRemove,
  className,
}: {
  label: string;
  children: React.ReactNode;
  onRemove?: () => void;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2", className)}>
      <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          title="Remove this layer"
          className="rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
        >
          <X size={14} />
        </button>
      )}
    </Card>
  );
}

const ADD: { kind: AddedKind; label: string; icon: React.ReactNode; title: string }[] = [
  { kind: "text", label: "Text", icon: <TextCursorInput size={14} />, title: "Free text, written here in the prompt" },
  { kind: "preset", label: "Preset", icon: <Bookmark size={14} />, title: "A saved snippet" },
  { kind: "embedding", label: "Embedding", icon: <Sparkles size={14} />, title: "An installed embedding" },
];

/** The chevron that folds a layer open or shut. */
export function ExpandButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Less" : "More"}
      title={open ? "Less" : "More"}
      className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-neutral-100"
    >
      {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
    </button>
  );
}

/** The "+" between two layers: adds a Text, Preset or Embedding layer there. */
export function AddLayer({
  onAdd,
  onCharacter,
}: {
  onAdd: (kind: AddedKind) => void;
  /** Adds a character to the Character layer; absent at the limit. */
  onCharacter?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative flex h-7 items-center gap-2.5 pl-6">
      <span className="h-full w-px bg-line-strong" aria-hidden />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add a layer here"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Add a layer here"
        className={cn(
          "grid h-5 w-5 place-items-center rounded-full border text-muted transition-colors",
          open
            ? "border-brand-500 bg-brand-900/50 text-neutral-50"
            : "border-dashed border-line-strong bg-neutral-950 hover:border-solid hover:border-brand-500 hover:text-neutral-50",
        )}
      >
        <Plus size={12} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-14 top-0 z-30 w-48 rounded-lg border border-line-strong bg-raised py-1 shadow-panel"
        >
          {onCharacter && (
            <button
              type="button"
              role="menuitem"
              title="Another character, in the Character layer"
              onClick={() => {
                onCharacter();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-line hover:text-white"
            >
              <UserRound size={14} />
              Character
            </button>
          )}
          {ADD.map((a) => (
            <button
              key={a.kind}
              type="button"
              role="menuitem"
              title={a.title}
              onClick={() => {
                onAdd(a.kind);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-200 hover:bg-line hover:text-white"
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Create or edit a preset. Saving changes it for every layer that uses it. */
function PresetDialog({
  open,
  onClose,
  kind,
  preset,
  initialText,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  kind: Preset["kind"];
  preset: Preset | null;
  initialText: string;
  onSaved: (p: Preset | null) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? "");
    setText(preset?.text ?? initialText);
    // Seed once per opening: a refetch mustn't wipe what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const done = (p: Preset | null) => {
    void qc.invalidateQueries({ queryKey: PRESETS_KEY });
    onSaved(p);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => (preset ? updatePreset(preset._id, { name, text }) : createPreset({ name, kind, text })),
    onSuccess: done,
    onError: (e) => toast.push(e.message, "error"),
  });
  const remove = useMutation({
    mutationFn: () => deletePreset(preset!._id),
    onSuccess: () => done(null),
    onError: (e) => toast.push(e.message, "error"),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={preset ? "Edit preset" : "New preset"}
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
          <Button variant="primary" onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Input aria-label="Preset name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          aria-label="Preset text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-2 font-mono text-xs text-neutral-100 outline-none focus:border-brand-600/60"
        />
      </div>
    </Dialog>
  );
}

/** Pick a preset of `kind` (or none), see its text, edit it or make a new one. */
export function PresetControl({
  kind,
  value,
  onChange,
  presets,
  label,
}: {
  kind: Preset["kind"];
  value: PresetRef;
  onChange: (v: PresetRef) => void;
  presets: readonly Preset[] | undefined;
  label: string;
}) {
  const [dialog, setDialog] = useState<"edit" | "new" | null>(null);
  const mine = (presets ?? []).filter((p) => p.kind === kind);
  const current = value ? (mine.find((p) => p._id === value.id) ?? null) : null;
  const deleted = !!value && !current && !!presets;
  const opts: PickerOption[] = [
    { value: NONE, label: "None" },
    ...mine.map((p) => ({ value: p._id, label: p.name, keywords: p.text })),
    ...(deleted ? [{ value: value!.id, label: "Deleted preset", dim: true }] : []),
    { value: NEW, label: "New preset" },
  ];
  const text = presetText(value, presets);
  return (
    <>
      <div className="w-48 shrink-0">
        <Picker
          aria-label={label}
          value={value?.id ?? NONE}
          options={opts}
          onChange={(v) => {
            if (v === NEW) setDialog("new");
            else if (v === NONE) onChange(null);
            else {
              const p = mine.find((x) => x._id === v);
              if (p) onChange({ id: p._id, text: p.text });
            }
          }}
          className="w-full"
        />
      </div>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-faint" title={text || undefined}>
        {text}
      </span>
      {current && (
        <Button size="sm" variant="ghost" onClick={() => setDialog("edit")} title="Edit this preset">
          Edit
        </Button>
      )}
      <PresetDialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        kind={kind}
        preset={dialog === "edit" ? current : null}
        initialText={dialog === "new" ? text : ""}
        onSaved={(p) => {
          if (p) onChange({ id: p._id, text: p.text });
          else if (dialog === "edit") onChange(null);
        }}
      />
    </>
  );
}

/** A free-text layer the user added. */
export function TextLayer({
  value,
  onChange,
  onRemove,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
}) {
  return (
    <LayerRow label="Text" onRemove={onRemove}>
      <input
        aria-label="Text layer"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Text"
        className="h-8 w-full rounded-md border border-line bg-neutral-950/70 px-2.5 text-sm text-neutral-100 placeholder:text-faint outline-none focus:border-brand-600/60"
      />
    </LayerRow>
  );
}

/** An installed embedding, as its own layer. */
export function EmbeddingLayer({
  value,
  onChange,
  onRemove,
  embeddings,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
  embeddings: readonly string[];
}) {
  return (
    <LayerRow label="Embedding" onRemove={onRemove}>
      <div className="w-64 max-w-full">
        <Picker
          aria-label="Embedding"
          value={value}
          options={embeddings.map((n) => ({ value: n, label: n }))}
          onChange={onChange}
          placeholder="Choose an embedding"
          searchable
          className="w-full"
        />
      </div>
    </LayerRow>
  );
}

/** The negative prompt: a preset plus its own text, folded to one line. */
export function NegativeLayer({
  preset,
  onPreset,
  presets,
  children,
  hasText,
}: {
  preset: PresetRef;
  onPreset: (v: PresetRef) => void;
  presets: readonly Preset[] | undefined;
  children: React.ReactNode;
  hasText: boolean;
}) {
  const [open, setOpen] = useState(hasText);
  return (
    <Card className="px-3.5 py-2">
      <div className="flex min-h-[2.25rem] items-center gap-3">
        <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Negative</span>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <PresetControl kind="negative" value={preset} onChange={onPreset} presets={presets} label="Negative preset" />
        </div>
        <ExpandButton open={open} onToggle={() => setOpen((v) => !v)} />
      </div>
      {open && <div className="mt-2 border-t border-line pt-2">{children}</div>}
    </Card>
  );
}
