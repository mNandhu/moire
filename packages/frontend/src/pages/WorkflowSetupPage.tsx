import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, FileUp, Loader2, Minus, Plus, Trash2, Wand2 } from "lucide-react";
import { Badge, Button, ButtonLink, Card, Checkbox, EmptyState, Input, PageBody, PageHeader, Picker, Tooltip } from "../components/ui";
import { TestBadge } from "../components/generate/WorkflowPicker";
import {
  GENERATORS_KEY,
  createGenerator,
  deleteGenerator,
  discoverGenerator,
  getGeneratorSetup,
  putGenerator,
  startTest,
  useComfyStatus,
  useGenerators,
  RejectedError,
  type GeneratorSetup,
  type GeneratorSlots,
  type GeneratorSourceIn,
  type SlotPath,
} from "../lib/generate";
import {
  canSave,
  checklist,
  defaultName,
  groupTicked,
  inputAt,
  leaveOut,
  pathKey,
  pickPrompt,
  pickerOptions,
  tickGroup,
  type Side,
} from "../lib/generatorSetup";
import { cn } from "../lib/cn";
import { canRunTest, testState } from "../lib/workflow";
import { useConfirm } from "../components/ConfirmDialog";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

/** A slot card: title, its state badge, then what it found. */
function SlotCard({
  title,
  badge,
  action,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-sm font-semibold text-neutral-50">{title}</h3>
        {badge}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </Card>
  );
}

function NodeLine({ title, path, extra }: { title: string; path: SlotPath | [string, number]; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-neutral-300">
      <span>{title}</span>
      <span className="font-mono text-xs text-faint">
        #{path[0]} {typeof path[1] === "string" ? path[1] : `out ${path[1]}`}
      </span>
      {extra}
    </div>
  );
}

/** Positive or negative: where Moiré writes the text, and the text the
 * workflow had there (the default Base / negative, editable). */
function PromptSlot({
  setup,
  side,
  slots,
  onSlots,
  text,
  onText,
  offer,
}: {
  setup: GeneratorSetup;
  side: Side;
  slots: GeneratorSlots;
  onSlots: (s: GeneratorSlots) => void;
  text: string;
  onText: (t: string) => void;
  offer?: { tags: string[]; without: string };
}) {
  const path = slots[side];
  const found = setup.found[side];
  const at = inputAt(setup, path);
  const same = !!found && !!path && found.path[0] === path[0] && found.path[1] === path[1];
  const badge = !path ? (
    <Badge tone="warning">Pick a node</Badge>
  ) : same && found?.from === "rule" ? (
    <Badge tone="success">From your extraction rule</Badge>
  ) : same && setup.found.sampler ? (
    <Badge tone="success">Found from the sampler</Badge>
  ) : (
    <Badge>Picked</Badge>
  );
  return (
    <SlotCard
      title={side === "positive" ? "Positive" : "Negative"}
      badge={badge}
      action={
        <Picker
          aria-label={`Pick the ${side} prompt node`}
          value={path ? pathKey(path) : ""}
          options={pickerOptions(setup, side)}
          searchable
          checks={false}
          align="right"
          onChange={(v) => {
            const input = setup.text_inputs.find((t) => pathKey(t.path) === v);
            if (input) onSlots(pickPrompt(slots, side, input));
          }}
          trigger={({ open }) => (
            <span
              className={cn(
                "inline-flex h-8 items-center rounded-lg border border-line bg-raised px-3 text-xs text-neutral-100 hover:border-line-strong",
                open && "border-brand-500/70",
              )}
            >
              {path ? "Pick another node" : "Pick a node"}
            </span>
          )}
        />
      }
    >
      {path && (
        <NodeLine
          title={at?.title ?? `Node ${path[0]}`}
          path={path}
          extra={
            slots.replace_links?.includes(side) && (
              <Tooltip content="This text is joined while the workflow runs. Writing here replaces the join with Moiré's prompt.">
                <Badge tone="warning">Replaces a join</Badge>
              </Tooltip>
            )
          }
        />
      )}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-muted">
          {side === "positive" ? "Default prompt" : "Default negative"}
        </label>
        <textarea
          value={text}
          onChange={(e) => onText(e.target.value)}
          rows={side === "positive" ? 4 : 2}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 outline-none focus-visible:border-brand-500/70"
        />
      </div>
      {offer && offer.tags.length > 0 && text.trim() !== offer.without.trim() && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/50 px-3 py-2 text-[13px]">
          <Tooltip content={offer.tags.join(", ")}>
            <span className="text-neutral-200">
              {offer.tags.length} {offer.tags.length === 1 ? "tag describes" : "tags describe"} a character or outfit
            </span>
          </Tooltip>
          <Tooltip content="Generate's Character and Outfit layers add these at queue time, so the default prompt doesn't need them.">
            <Button size="sm" className="ml-auto" onClick={() => onText(offer.without)}>
              Remove from the prompt
            </Button>
          </Tooltip>
        </div>
      )}
    </SlotCard>
  );
}

/** The setup form for a discovered graph: slots, name, checklist, Save. */
function SetupForm({
  setup,
  initialName,
  saving,
  saveLabel,
  onSave,
}: {
  setup: GeneratorSetup;
  initialName: string;
  saving: boolean;
  saveLabel: string;
  onSave: (v: { name: string; slots: GeneratorSlots; defaults: { base: string; negative: string } }) => void;
}) {
  const [slots, setSlots] = useState<GeneratorSlots>(setup.slots);
  const [name, setName] = useState(initialName);
  const [base, setBase] = useState(setup.defaults.base);
  const [negative, setNegative] = useState(setup.defaults.negative);
  const [lorasOn, setLorasOn] = useState(!!setup.slots.lora_model || !setup.found.lora);
  const items = checklist(setup, slots);
  const lora = setup.found.lora;
  const seedsOn = new Set((slots.seeds ?? []).map(pathKey));
  const ckpt = setup.found.checkpoint;

  const save = () => {
    const out: GeneratorSlots = { ...slots };
    if (!lorasOn || !lora) {
      delete out.lora_model;
      delete out.lora_clip;
    } else {
      out.lora_model = lora.model.ref;
      out.lora_clip = lora.clip?.ref ?? null;
    }
    onSave({ name: name.trim() || initialName, slots: out, defaults: { base, negative } });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
      <div className="space-y-4">
        <PromptSlot
          setup={setup}
          side="positive"
          slots={slots}
          onSlots={setSlots}
          text={base}
          onText={setBase}
          offer={{ tags: setup.offer, without: setup.base_without }}
        />
        <PromptSlot setup={setup} side="negative" slots={slots} onSlots={setSlots} text={negative} onText={setNegative} />

        <SlotCard
          title="Seed"
          badge={
            setup.seeds.length ? (
              <Badge tone="success">{(slots.seeds ?? []).length} randomized</Badge>
            ) : (
              <Badge>None found</Badge>
            )
          }
        >
          {setup.seeds.map((g) => (
            <div key={g.value} className="rounded-lg border border-line px-3 py-2.5">
              <Checkbox
                checked={groupTicked(slots, g)}
                onChange={(on) => setSlots(tickGroup(slots, g, on))}
                label={
                  <span className="text-[13px] text-neutral-200">
                    {g.inputs.length > 1 ? `${g.inputs.length} inputs share one seed` : "Seed"}{" "}
                    <span className="font-mono text-xs text-faint">{g.value}</span>
                  </span>
                }
              />
              <ul className="mt-1.5 space-y-0.5 pl-7">
                {g.inputs.flatMap((i) =>
                  i.used_by.map((u) => (
                    <li key={`${pathKey(i.path)}-${u.node}`} className="text-xs text-muted">
                      {u.title} <span className="font-mono text-faint">#{u.node}</span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          ))}
          {seedsOn.size === 0 && setup.seeds.length > 0 && (
            <p className="text-xs text-amber-200">Every image repeats with no seed ticked.</p>
          )}
        </SlotCard>

        <div className="grid gap-4 md:grid-cols-2">
          <SlotCard
            title="Size"
            badge={slots.width && slots.height ? <Badge tone="success">Found</Badge> : <Badge>Set in the workflow</Badge>}
          >
            {slots.width ? (
              <NodeLine title="Latent" path={slots.width} />
            ) : (
              <p className="text-xs text-muted">Generate shows the workflow's own size.</p>
            )}
          </SlotCard>

          <SlotCard
            title="Images per request"
            badge={slots.batch_size ? <Badge tone="success">Found</Badge> : <Badge>Set in the workflow</Badge>}
          >
            {slots.batch_size ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Fewer"
                  onClick={() => setSlots({ ...slots, per_request: Math.max(1, (slots.per_request ?? 1) - 1) })}
                  className="rounded-md border border-line p-1.5 text-muted hover:text-neutral-100"
                >
                  <Minus size={14} />
                </button>
                <span className="w-8 text-center tabular-nums">{slots.per_request ?? 1}</span>
                <button
                  type="button"
                  aria-label="More"
                  onClick={() => setSlots({ ...slots, per_request: Math.min(64, (slots.per_request ?? 1) + 1) })}
                  className="rounded-md border border-line p-1.5 text-muted hover:text-neutral-100"
                >
                  <Plus size={14} />
                </button>
              </div>
            ) : (
              <p className="text-xs text-muted">Count in Generate is in requests.</p>
            )}
          </SlotCard>

          <SlotCard title="Checkpoint" badge={slots.checkpoint ? <Badge tone="success">Chosen in Generate</Badge> : <Badge>Set in the workflow</Badge>}>
            {ckpt ? (
              <Checkbox
                checked={!!slots.checkpoint}
                onChange={(on) => {
                  const next = { ...slots };
                  if (on) next.checkpoint = ckpt.path;
                  else delete next.checkpoint;
                  setSlots(next);
                }}
                label={<span className="text-[13px]">Choose the checkpoint in Generate</span>}
                hint={
                  <span className="font-mono">
                    {ckpt.value}
                    {ckpt.installed === false && <span className="ml-2 font-sans text-amber-200">not on ComfyUI</span>}
                  </span>
                }
              />
            ) : (
              <p className="text-xs text-muted">No checkpoint loader found.</p>
            )}
          </SlotCard>

          <SlotCard
            title="Sampling"
            badge={["sampler", "scheduler", "steps", "cfg"].some((k) => slots[k as keyof GeneratorSlots]) ? <Badge tone="success">Found</Badge> : <Badge>Set in the workflow</Badge>}
          >
            <p className="text-xs text-muted">
              {(["sampler", "scheduler", "steps", "cfg"] as const).filter((k) => slots[k]).join(", ") || "Nothing Generate can change"}
            </p>
          </SlotCard>
        </div>

        <SlotCard
          title="Output"
          badge={
            setup.outputs.some((o) => o.saves) ? <Badge tone="success">Saves into the library</Badge> : <Badge tone="danger">No Save Image</Badge>
          }
        >
          {setup.outputs.map((o) => (
            <div key={o.node} className={cn("flex items-center gap-2.5 text-[13px]", !o.saves && "text-faint")}>
              <span>{o.title}</span>
              <span className="font-mono text-xs text-faint">#{o.node}</span>
              <span className="text-xs">{o.saves ? (o.prefix ?? "") : "temporary, ignored"}</span>
            </div>
          ))}
          {setup.input_images.map((i) => (
            <Tooltip key={i.node} content="Moiré can't change this image yet: the workflow uses the file ComfyUI already has.">
              <div className="flex items-center gap-2.5 text-[13px] text-amber-200">
                <CircleAlert size={14} /> Uses an input image: {i.title} <span className="font-mono text-xs">#{i.node}</span>
              </div>
            </Tooltip>
          ))}
        </SlotCard>

        <SlotCard
          title="LoRA insertion point"
          badge={lora ? <Badge tone="success">Found</Badge> : <Badge>None found</Badge>}
          action={
            lora && <Checkbox checked={lorasOn} onChange={setLorasOn} label={<span className="text-xs">Let Moiré add LoRAs</span>} />
          }
        >
          {lora ? (
            <div className="space-y-1.5 text-[13px] text-neutral-300">
              <NodeLine title={`Model from ${lora.model.title}`} path={lora.model.ref} />
              {lora.clip ? (
                <NodeLine title={`CLIP from ${lora.clip.title}`} path={lora.clip.ref} />
              ) : (
                <p className="text-xs text-muted">Model only: this loader has no CLIP output.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted">The Style layer and character LoRAs are off for this workflow.</p>
          )}
        </SlotCard>

        {(setup.found.loras?.length ?? 0) > 0 && (
          <SlotCard title="The workflow's own LoRAs">
            <ul className="space-y-1.5">
              {setup.found.loras!.map((l) => (
                <li key={l.node} className="flex flex-wrap items-center gap-2.5 text-[13px]">
                  <span className={cn("min-w-0 truncate", (slots.drop_loras ?? []).includes(l.node) ? "text-faint line-through" : "text-neutral-200")}>
                    {l.name.replace(/\.safetensors$/, "").split("/").pop()}
                  </span>
                  {l.strength != null && <span className="font-mono text-xs text-faint">{+l.strength.toFixed(2)}</span>}
                  {l.installed === false && <Badge tone="warning">Not on ComfyUI</Badge>}
                  <Checkbox
                    className="ml-auto"
                    checked={(slots.drop_loras ?? []).includes(l.node)}
                    onChange={(out) => setSlots(leaveOut(slots, l.node, out))}
                    label={<span className="text-xs">Leave out</span>}
                  />
                </li>
              ))}
            </ul>
          </SlotCard>
        )}
      </div>

      <div className="space-y-4 lg:sticky lg:top-[5.5rem]">
        <Card className="space-y-3 p-4">
          <div>
            <label htmlFor="wf-name" className="mb-1.5 block text-xs font-medium text-muted">
              Name
            </label>
            <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-muted">Before it can be used</div>
            <ul className="space-y-1.5">
              {items.map((i) => (
                <li key={i.label} className={cn("flex items-start gap-2 text-[13px]", i.ok ? "text-neutral-200" : "text-amber-200")}>
                  {i.note ? (
                    <CircleAlert size={14} className="mt-0.5 shrink-0 text-faint" />
                  ) : i.ok ? (
                    <Check size={14} className="mt-0.5 shrink-0 text-emerald-300" />
                  ) : (
                    <CircleAlert size={14} className="mt-0.5 shrink-0" />
                  )}
                  {i.label}
                </li>
              ))}
            </ul>
          </div>
          <Button variant="primary" className="w-full" disabled={!canSave(items) || saving} onClick={save}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
            {saveLabel}
          </Button>
        </Card>
      </div>
    </div>
  );
}

/** Where a new workflow comes from: an Export (API) file, or a workflow
 * family from the extraction rules. */
function SourceStep({ onSource, error }: { onSource: (s: GeneratorSourceIn) => void; error: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const read = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    try {
      onSource({ graph: JSON.parse(await file.text()), filename: file.name });
    } catch {
      setReadError(`${file.name} isn't JSON`);
    }
  };
  const shown = readError ?? error;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void read(e.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-3 rounded-xl border-[1.5px] border-dashed px-4 py-10 text-center",
          drag ? "border-brand-500 bg-brand-900/20" : "border-line-strong",
        )}
      >
        <FileUp size={22} className="text-muted" />
        <span className="text-sm text-neutral-100">Drop an Export (API) file</span>
        <span className="inline-flex h-8 items-center rounded-lg border border-line bg-raised px-3 text-xs">Choose file</span>
        <input ref={input} type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void read(e.target.files?.[0])} />
      </label>
      {shown && (
        <div role="alert" className="rounded-lg border border-red-800/70 bg-red-950/30 px-3.5 py-3 text-sm text-red-200">
          {shown}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-faint">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>
      <div className="text-center">
        <ButtonLink to="/rules" size="sm">
          Pick a workflow from your images
        </ButtonLink>
      </div>
    </div>
  );
}

/** A saved workflow's test run: start it (again), follow it, and once it
 * passed, open Generate on it. */
function TestStep({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: generators } = useGenerators();
  const { data: status } = useComfyStatus();
  const gen = generators?.find((g) => g._id === id);
  const run = useMutation({
    mutationFn: () => startTest(id, null),
    onSettled: () => qc.invalidateQueries({ queryKey: GENERATORS_KEY }),
  });
  if (!gen) return null;
  const t = gen.test;
  const state = testState(gen);
  const connected = !!status?.connected;
  const rejected = run.error instanceof RejectedError ? run.error.nodeErrors : null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 className="text-sm font-semibold text-neutral-50">Test run</h3>
        <TestBadge gen={gen} />
        <div className="ml-auto flex gap-2">
          {state === "ready" ? (
            <Button variant="primary" size="sm" onClick={() => navigate(`/generate?workflow=${encodeURIComponent(id)}`)}>
              <Wand2 size={14} /> Open in Generate
            </Button>
          ) : (
            <Tooltip
              content={
                connected
                  ? "One image with the default prompt and, where it can, one LoRA at strength 0: proves the prompts, the output folder and the insertion point."
                  : "Waiting for ComfyUI"
              }
            >
              <Button
                variant="primary"
                size="sm"
                disabled={!connected || run.isPending || !canRunTest(state)}
                onClick={() => run.mutate()}
              >
                {(run.isPending || state === "running") && <Loader2 size={14} className="animate-spin" />}
                {state === "running" ? "Running" : state === "untested" ? "Run test image" : "Run again"}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
      {state === "failed" && t?.error && (
        <p className="font-mono text-xs text-red-300">
          {t.error.class_type} {t.error.node && `node ${t.error.node}`}: {t.error.message}
        </p>
      )}
      {state === "failed" && t?.state === "done" && <p className="text-xs text-red-300">Returned 0 images</p>}
      {state === "waiting" && (
        <p className="text-xs text-muted">
          It made {t?.outputs} {t?.outputs === 1 ? "image" : "images"}; waiting for the library scan. If nothing arrives, check
          that the workflow saves into ComfyUI's output folder.
        </p>
      )}
      {rejected ? (
        <ul className="space-y-1 font-mono text-xs text-red-300">
          {rejected.map((e, i) => (
            <li key={i}>
              {e.class_type ?? "Node"} {e.added ? "(added by Moiré)" : `#${e.node}`}: {e.input ? `${e.input}: ` : ""}
              {e.message}
            </li>
          ))}
        </ul>
      ) : (
        run.error && <p className="text-xs text-red-300">{run.error.message}</p>
      )}
    </Card>
  );
}

/** A short stable hash of a string: an uploaded graph's cache key. */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export default function WorkflowSetupPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const image = params.get("image");
  const [source, setSource] = useState<GeneratorSourceIn | null>(image ? { image_id: image } : null);
  useEffect(() => {
    if (image) setSource({ image_id: image });
  }, [image]);
  const { data: generators } = useGenerators();
  const saved = id ? generators?.find((g) => g._id === id) : undefined;
  useDocumentTitle(saved ? `Set up ${saved.name}` : "Set up a workflow");

  const sourceKey = useMemo(
    () => (source && "image_id" in source ? source.image_id : source ? `upload:${hashOf(JSON.stringify(source))}` : null),
    [source],
  );
  const discovered = useQuery({
    queryKey: ["generate", "discover", sourceKey],
    queryFn: () => discoverGenerator(source!),
    enabled: !id && !!source,
    retry: false,
    staleTime: Infinity,
  });
  const existing = useQuery({
    queryKey: ["generate", "setup", id],
    queryFn: ({ signal }) => getGeneratorSetup(id!, signal),
    enabled: !!id,
    retry: false,
  });
  const setup = id ? existing.data : discovered.data;
  const loadError = (id ? existing.error : discovered.error) as Error | null;

  const create = useMutation({
    mutationFn: async (v: { name: string; slots: GeneratorSlots; defaults: { base: string; negative: string } }) => {
      const gen = await createGenerator({ source: source!, ...v });
      try {
        await startTest(gen._id, null);
      } catch (e) {
        toast.push(`Saved. The test didn't start: ${(e as Error).message}`, "error");
      }
      return gen;
    },
    onSuccess: (gen) => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      navigate(`/generate/workflows/${gen._id}`, { replace: true });
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });
  const update = useMutation({
    mutationFn: (v: { name: string; slots: GeneratorSlots; defaults: { base: string; negative: string } }) => putGenerator(id!, v),
    onSuccess: (g) => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      void qc.invalidateQueries({ queryKey: ["generate", "setup", id] });
      toast.push(g.ready ? "Saved" : "Saved. Run the test again before queueing.", "success");
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });
  const confirm = useConfirm();
  const remove = useMutation({
    mutationFn: () => deleteGenerator(id!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: GENERATORS_KEY });
      navigate("/generate");
    },
    onError: (e) => toast.push((e as Error).message, "error"),
  });

  const title = saved ? `Set up "${saved.name}"` : setup ? `Set up "${defaultName(setup)}"` : "Set up a workflow";
  const origin =
    setup?.source.kind === "image"
      ? setup.source.family_name || setup.source.file_name
        ? `From ${setup.source.family_name ?? setup.source.file_name}`
        : "From an image"
      : setup?.source.kind === "upload"
        ? (setup.source.filename ?? "Uploaded file")
        : undefined;

  return (
    <>
      <PageHeader
        title={title}
        description={origin}
        width="wide"
        actions={
          id && (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: `Delete ${saved?.name ?? "this workflow"}?`,
                  message: "Its setup and test run go. Batches made with it stay, and so do their images.",
                  confirmLabel: "Delete workflow",
                  tone: "danger",
                });
                if (ok) remove.mutate();
              }}
            >
              <Trash2 size={14} /> Delete
            </Button>
          )
        }
      />
      <PageBody width="wide">
        <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-faint">
          <Link to="/generate" className="text-muted hover:text-neutral-100">
            Generate
          </Link>
          <span className="mx-1.5">/</span>
          {id ? "Workflow setup" : "Set up a workflow"}
        </nav>
        {id && <div className="mb-4"><TestStep id={id} /></div>}
        {!id && !source ? (
          <SourceStep onSource={setSource} error={null} />
        ) : loadError ? (
          id ? (
            <EmptyState icon={CircleAlert} title={loadError.message} />
          ) : (
            <SourceStep onSource={setSource} error={loadError.message} />
          )
        ) : !setup || (id && !saved) ? (
          <div className="flex justify-center py-16">
            <Loader2 className="animate-spin text-muted" />
          </div>
        ) : (
          <SetupForm
            key={id ?? sourceKey ?? ""}
            setup={setup}
            initialName={saved?.name ?? defaultName(setup)}
            saving={create.isPending || update.isPending}
            saveLabel={id ? "Save" : "Save and run test"}
            onSave={(v) => (id ? update.mutate(v) : create.mutate(v))}
          />
        )}
      </PageBody>
    </>
  );
}
