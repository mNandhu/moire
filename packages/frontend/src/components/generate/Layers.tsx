import { useRef, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Sparkles, TextCursorInput, UserRound, X, Bookmark } from "lucide-react";
import { Button, Card } from "../ui";
import { DropdownMenu, type DropdownItem } from "../ui/DropdownMenu";
import { Picker } from "../ui/Picker";
import { cn } from "../../lib/cn";
import {
  PRESETS_KEY,
  createPreset,
  deletePreset,
  updatePreset,
  type Preset,
} from "../../lib/generate";
import { presetText, type AddedKind, type PresetRef } from "../../lib/generateForm";
import { PresetDialogShell } from "./PresetDialogShell";
import { PresetPicker } from "./PresetPicker";

/** A one-line layer: label, controls, and an optional remove button. */
export function LayerRow({
  label,
  children,
  onRemove,
  className,
  footer,
}: {
  label: string;
  children: React.ReactNode;
  onRemove?: () => void;
  className?: string;
  /** Under the row, inside the card. */
  footer?: React.ReactNode;
}) {
  const row = (
    <>
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
    </>
  );
  return (
    <Card className={cn("px-3.5 py-2", className)}>
      <div className="flex min-h-[2.25rem] items-center gap-3">{row}</div>
      {footer}
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
  const items: DropdownItem[] = [
    ...(onCharacter
      ? [{ label: "Character", icon: <UserRound size={14} />, title: "Another character, in the Character layer", onClick: onCharacter }]
      : []),
    ...ADD.map((a) => ({ label: a.label, icon: a.icon, title: a.title, onClick: () => onAdd(a.kind) })),
  ];
  return (
    <div className="flex h-7 items-center gap-2.5 pl-6">
      <span className="h-full w-px bg-line-strong" aria-hidden />
      <DropdownMenu
        aria-label="Add a layer here"
        items={items}
        onOpenChange={setOpen}
        trigger={
          <span
            title="Add a layer here"
            className={cn(
              "grid h-5 w-5 place-items-center rounded-full border text-muted transition-colors",
              open
                ? "border-brand-500 bg-brand-900/50 text-neutral-50"
                : "border-dashed border-line-strong bg-neutral-950 hover:border-solid hover:border-brand-500 hover:text-neutral-50",
            )}
          >
            <Plus size={12} />
          </span>
        }
      />
    </div>
  );
}

/** Create or edit a preset. Saving changes it for every layer that uses it. */
function PresetDialog({
  onClose,
  kind,
  preset,
  initialText,
  onSaved,
}: {
  onClose: () => void;
  kind: Preset["kind"];
  preset: Preset | null;
  initialText: string;
  onSaved: (p: Preset | null) => void;
}) {
  const [name, setName] = useState(preset?.name ?? "");
  const [text, setText] = useState(preset?.text ?? initialText);
  return (
    <PresetDialogShell
      title={preset ? "Edit preset" : "New preset"}
      editing={!!preset}
      name={name}
      onName={setName}
      canSave
      queryKey={PRESETS_KEY}
      save={() => (preset ? updatePreset(preset._id, { name, text }) : createPreset({ name, kind, text }))}
      remove={() => deletePreset(preset!._id)}
      onClose={onClose}
      onSaved={onSaved}
    >
      <textarea
        aria-label="Preset text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-2 font-mono text-xs text-neutral-100 outline-none focus:border-brand-600/60"
      />
    </PresetDialogShell>
  );
}

/** Pick a preset of `kind` (or none), see its text, edit it or make a new one. */
export function PresetControl({
  kind,
  value,
  onChange,
  presets,
  label,
  extra,
  onPreview,
}: {
  kind: Preset["kind"];
  value: PresetRef;
  onChange: (v: PresetRef) => void;
  presets: readonly Preset[] | undefined;
  label: string;
  /** The layer's own text, shown after the preset's in the one-line preview. */
  extra?: string;
  /** Makes the preview a button (opening where `extra` is written). */
  onPreview?: () => void;
}) {
  const [dialog, setDialog] = useState<"edit" | "new" | null>(null);
  const mine = (presets ?? []).filter((p) => p.kind === kind);
  const current = value ? (mine.find((p) => p._id === value.id) ?? null) : null;
  const text = presetText(value, presets);
  return (
    <>
      <div className="w-48 shrink-0">
        <PresetPicker
          aria-label={label}
          presets={mine}
          loaded={!!presets}
          value={value?.id}
          onPick={(p) => onChange(p ? { id: p._id, text: p.text } : null)}
          onNew={() => setDialog("new")}
        />
      </div>
      <PresetPreview text={text} extra={extra} onClick={onPreview} />
      {current && (
        <Button size="sm" variant="ghost" onClick={() => setDialog("edit")} title="Edit this preset">
          Edit
        </Button>
      )}
      {dialog && (
        <PresetDialog
          onClose={() => setDialog(null)}
          kind={kind}
          preset={dialog === "edit" ? current : null}
          initialText={dialog === "new" ? text : ""}
          onSaved={(p) => {
            if (p) onChange({ id: p._id, text: p.text });
            else if (dialog === "edit") onChange(null);
          }}
        />
      )}
    </>
  );
}

/** A preset's text on one line, then the layer's own; a button when
 * clicking it opens where the own text is written. */
function PresetPreview({ text, extra, onClick }: { text: string; extra?: string; onClick?: () => void }) {
  const own = extra?.trim();
  const full = [text, own].filter(Boolean).join(", ");
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={full || undefined}
      className={cn(
        "min-w-0 flex-1 truncate text-left font-mono text-xs text-faint",
        onClick && "self-stretch hover:text-muted",
      )}
    >
      {text}
      {text && own && ", "}
      {own && <span className="text-muted">{own}</span>}
    </Tag>
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

/** The negative prompt: a preset plus its own text, folded to one line
 * that shows both, like the Prefix row; unfolding (or the line) opens the text. */
export function NegativeLayer({
  preset,
  onPreset,
  presets,
  children,
  text,
}: {
  preset: PresetRef;
  onPreset: (v: PresetRef) => void;
  presets: readonly Preset[] | undefined;
  children: React.ReactNode;
  text: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Clicking the line is asking to write: land in the text.
  const openToWrite = () => {
    setOpen(true);
    requestAnimationFrame(() => bodyRef.current?.querySelector("textarea")?.focus());
  };
  return (
    <Card className="px-3.5 py-2">
      <div className="flex min-h-[2.25rem] items-center gap-3">
        <span className="w-[4.5rem] shrink-0 text-xs font-medium text-muted">Negative</span>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <PresetControl
            kind="negative"
            value={preset}
            onChange={onPreset}
            presets={presets}
            label="Negative preset"
            extra={open ? undefined : text}
            onPreview={open ? undefined : openToWrite}
          />
        </div>
        <ExpandButton open={open} onToggle={() => setOpen((v) => !v)} />
      </div>
      {open && (
        <div ref={bodyRef} className="mt-2 border-t border-line pt-2">
          {children}
        </div>
      )}
    </Card>
  );
}
