import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, FlaskConical, Loader2, Lock, Wand2 } from "lucide-react";
import { Button, ButtonLink, Card, EmptyState, PageBody, PageHeader } from "../components/ui";
import { bareTagPool } from "../components/generate/ChipInput";
import {
  BatchName,
  CheckpointPicker,
  SamplingControl,
  CountStepper,
  QueueCard,
  SeedControl,
  SizePicker,
  stemOf,
} from "../components/generate/RunControls";
import { CharacterLayer } from "../components/generate/CharacterBlock";
import { StyleLayer } from "../components/generate/StyleLayer";
import { ComfyStatusLine } from "../components/generate/ComfyStatusLine";
import { useCharacters } from "../components/ImageCharacters";
import { LatestResults } from "../components/generate/LatestResults";
import { NextBatch, useNextEstimate } from "../components/generate/NextBatch";
import { RecentBatches } from "../components/generate/RecentBatches";
import { autoBatchName } from "../lib/batchName";
import {
  BATCHES_KEY,
  GENERATORS_KEY,
  MODELS_KEY,
  RejectedError,
  STATUS_KEY,
  queueBatch,
  refreshModels,
  startTest,
  useComfyModels,
  useComfySettings,
  useComfyStatus,
  useBatches,
  useGenerators,
  useLoraPresets,
  usePresets,
  useRecipes,
  type CharacterInput,
  type NodeError,
} from "../lib/generate";
import {
  insertBlock,
  MAX_CHARACTERS,
  loadDraft,
  nameWords,
  previewText,
  rejectedFields,
  removeBlock,
  saveDraft,
  toParts,
  toEstimateBody,
  toQueueBody,
  updateBlock,
  type GenerateForm,
} from "../lib/generateForm";
import { checkCountTags, fixCountTags, type Kind } from "../lib/countTags";
import { queueTitle } from "../lib/eta";
import { cn } from "../lib/cn";
import type { CountMode } from "../lib/requests";
import { PromptInput } from "../components/generate/PromptInput";
import { AddLayer, EmbeddingLayer, LayerRow, NegativeLayer, PresetControl, TextLayer } from "../components/generate/Layers";
import { characterPageQuery, useTagAggregate } from "../lib/queries";
import { characterColours, displayName, mixColours } from "../lib/character";
import { useAmbientTint } from "../lib/ambient";
import { characterInput, characterTags } from "../lib/recipe";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

const NO_STRINGS: string[] = [];

/** ComfyUI's rejection: the node errors, with Refresh models / Dismiss. */
function RejectedBox({
  errors,
  onRefresh,
  onDismiss,
  refreshing,
}: {
  errors: NodeError[];
  onRefresh: () => void;
  onDismiss: () => void;
  refreshing: boolean;
}) {
  return (
    <div role="alert" className="rounded-lg border border-red-800/70 bg-red-950/30 px-3.5 py-3 text-sm">
      <div className="flex items-start gap-2 text-red-200">
        <CircleAlert size={16} className="mt-0.5 shrink-0" />
        <span>Nothing was queued</span>
      </div>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
        {errors.map((e, i) => (
          <div key={i} className="contents">
            <dt className="truncate text-red-200">
              {e.class_type ?? "Node"}{" "}
              <span className="font-mono text-2xs text-red-300/80">{e.added ? "added by Moiré" : `node ${e.node}`}</span>
            </dt>
            <dd className="font-mono text-red-300" title={e.details || undefined}>
              {e.input ? `${e.input}: ` : ""}
              {e.message}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onRefresh} disabled={refreshing}>
          Refresh models
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** The test-run gate: one image proves the output folder and the checkpoint. */
function TestRunCard({ checkpoint, disabled }: { checkpoint: string | null; disabled: boolean }) {
  const qc = useQueryClient();
  const { data: generators } = useGenerators();
  const gen = generators?.[0];
  const [errors, setErrors] = useState<NodeError[] | null>(null);
  const run = useMutation({
    mutationFn: () => startTest("builtin", checkpoint),
    onMutate: () => setErrors(null),
    onError: (e) => {
      if (e instanceof RejectedError) setErrors(e.nodeErrors);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: GENERATORS_KEY }),
  });
  const t = gen?.test;
  const running = !!t && ["pending", "queued", "running"].includes(t.state);
  const waiting = !!t && t.state === "done" && !t.image_id;
  const failed = t && ["failed", "lost", "cancelled"].includes(t.state);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-neutral-100">Test run</div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => run.mutate()}
          disabled={disabled || running || waiting || run.isPending}
          title={disabled ? "Waiting for connection" : "One image at the chosen checkpoint"}
        >
          {(running || waiting || run.isPending) && <Loader2 size={14} className="animate-spin" />}
          {running ? "Running" : waiting ? "Waiting for scan" : "Test run"}
        </Button>
      </div>
      {failed && t?.error && (
        <div className="mt-2 font-mono text-xs text-red-300">
          {t.error.class_type} {t.error.node && `node ${t.error.node}`}: {t.error.message}
        </div>
      )}
      {failed && !t?.error && <div className="mt-2 text-xs text-red-300">{t?.state === "lost" ? "Lost" : "Cancelled"}</div>}
      {waiting && t.outputs === 0 && <div className="mt-2 text-xs text-red-300">Returned 0 images</div>}
      {run.error && !(run.error instanceof RejectedError) && (
        <div className="mt-2 text-xs text-red-300">{run.error.message}</div>
      )}
      {errors && (
        <div className="mt-3">
          <RejectedBox errors={errors} onRefresh={() => refreshModels()} onDismiss={() => setErrors(null)} refreshing={false} />
        </div>
      )}
    </Card>
  );
}

export default function GeneratePage() {
  useDocumentTitle("Generate");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: status } = useComfyStatus();
  const { data: settings } = useComfySettings();
  const { data: models } = useComfyModels();
  const { data: generators } = useGenerators();
  const { data: newest } = useBatches(1);
  const { data: presets } = usePresets();
  const { data: loraPresets } = useLoraPresets();
  const { data: tagAgg } = useTagAggregate({ includePrompt: true });
  const [form, setForm] = useState<GenerateForm>(() => loadDraft());
  const [rejected, setRejected] = useState<NodeError[] | null>(null);
  // The "+" between layers asked for another character: the Character layer
  // shows a row with its picker open.
  const [addingCharacter, setAddingCharacter] = useState(false);
  const addCharacter = form.characters.length < MAX_CHARACTERS ? () => setAddingCharacter(true) : undefined;
  const set = <K extends keyof GenerateForm>(k: K, v: GenerateForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => saveDraft(form), [form]);

  const gen = generators?.[0];
  const hasSampling = Object.keys(gen?.sampling ?? {}).length > 0;
  const checkpoints = models?.checkpoints ?? NO_STRINGS;
  // The first installed checkpoint until the user picks one.
  useEffect(() => {
    if (!form.checkpoint && checkpoints.length) set("checkpoint", checkpoints[0]);
  }, [checkpoints, form.checkpoint]);

  const pool = useMemo(() => bareTagPool(tagAgg ?? []), [tagAgg]);
  const usage = useMemo(() => new Map((models?.matching ?? []).map((m) => [m.stem, m.images])), [models]);
  const flagged = useMemo(() => rejectedFields(rejected ?? []), [rejected]);
  const { data: everyone } = useCharacters();
  const recipes = useRecipes(form.characters);
  const labels = form.characters.map(
    (tag) => displayName(everyone?.find((c) => c.tag === tag) ?? { tag }).name,
  );
  // Each block as it would be sent; null until its recipe has loaded.
  const inputs = form.characters.map((tag, i) => {
    const r = recipes[i];
    return r && r.tag === tag ? characterInput(r, labels[i]) : null;
  });
  const characters = inputs.every((c) => c) ? (inputs as CharacterInput[]) : null;
  const autoName = autoBatchName({
    number: null,
    generator: gen?.name ?? "Built-in",
    extra: nameWords(form),
    character: labels.length ? labels.join(" & ") : null,
  });

  // The page takes the picked characters' colours: one character's own
  // three, else one from each (their colour in the character list).
  const one = form.characters.length === 1 ? form.characters[0] : "";
  const { data: onePage } = useQuery({ ...characterPageQuery(one), enabled: !!one });
  useAmbientTint(
    onePage && one
      ? characterColours(onePage)
      : mixColours(form.characters.map((tag) => {
          const c = everyone?.find((e) => e.tag === tag)?.color;
          return c ? [c] : [];
        })),
  );
  const defaultPerRequest = settings?.builtin_per_request ?? 1;
  // A size per batch only on the built-in for now (custom Generators: phase 3).
  const ownBatchSize = gen?.kind === "builtin" && !!gen.slots.batch_size;
  // How the backend will split the count, per Generator.
  const genPerRequest = typeof gen?.slots.per_request === "number" ? gen.slots.per_request : null;
  const countMode: CountMode = ownBatchSize
    ? { kind: "images", perRequest: form.perRequest ?? defaultPerRequest }
    : gen?.slots.batch_size && genPerRequest
      ? { kind: "images", perRequest: genPerRequest }
      : { kind: "unknown" };
  const connected = !!status?.connected;

  const queue = useMutation({
    mutationFn: () => queueBatch(toQueueBody(form, gen?._id ?? "builtin", characters ?? [], presets, loraPresets)),
    onMutate: () => setRejected(null),
    onSuccess: (b) => {
      toast.push(`Queued ${b.name}`, "success");
      set("name", null);
      void qc.invalidateQueries({ queryKey: STATUS_KEY });
      void qc.invalidateQueries({ queryKey: BATCHES_KEY });
    },
    onError: (e) => {
      if (e instanceof RejectedError) setRejected(e.nodeErrors);
      else toast.push(e.message, "error");
    },
  });
  const refresh = useMutation({
    mutationFn: refreshModels,
    onSuccess: (m) => qc.setQueryData(MODELS_KEY, m),
  });

  // Count tags (1girl, solo...) in the main prompt against the cast, once
  // every picked character's recipe is in.
  const genders =
    recipes.length && recipes.every(Boolean) ? JSON.stringify(recipes.map((r) => r!.gender)) : null;
  const counts = useMemo(
    () => (genders ? checkCountTags(form.prompt, JSON.parse(genders) as (Kind | null)[]) : null),
    [form.prompt, genders],
  );

  // How long the form's batch would take, for the next-batch card.
  const estimate = useNextEstimate(gen?.ready && connected ? toEstimateBody(form, gen._id) : null, {
    busy: !!status?.active.length,
  });

  if (status && !status.configured) {
    return (
      <>
        <PageHeader title="Generate" />
        <PageBody>
          <EmptyState
            icon={Wand2}
            title="Connect ComfyUI"
            actions={<ButtonLink to="/settings?section=comfyui" variant="primary">ComfyUI settings</ButtonLink>}
          />
        </PageBody>
      </>
    );
  }

  const parts = toParts(form, presets, loraPresets);
  const positive = previewText(
    parts.positive,
    recipes.flatMap((r) => (r ? [characterTags(r)] : [])),
  );
  const negative = previewText(parts.negative, []);
  const countFix = counts?.expected?.length
    ? {
        label: `Use ${counts.expected.join(", ")}`,
        apply: () => set("prompt", fixCountTags(form.prompt, counts.expected!)),
      }
    : null;
  // As the backend merges them: characters' LoRAs first, each file once.
  const sentLoras = [...(characters ?? []).flatMap((c) => (c.lora ? [c.lora] : [])), ...form.loras].filter(
    (l, i, all) => all.findIndex((x) => stemOf(x.name) === stemOf(l.name)) === i,
  );
  const ready = !!gen?.ready;
  // Why Queue can't run yet, said on the button itself.
  const blocked = !connected
    ? "Waiting for ComfyUI"
    : !ready
      ? "Run the test first"
      : !settings?.output_library_id
        ? "Set the output folder"
        : form.characters.length && !characters
          ? "Loading character"
          : null;
  const canQueue = !blocked && !queue.isPending;

  return (
    <>
      {/* On the right: which Generator this page runs, then one status, with
          ComfyUI's state and the Generator's test run folded into a word. */}
      <PageHeader
        title="Generate"
        width="wide"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm">
            <span className="text-muted">
              Generator <span className="font-medium text-neutral-100">{gen?.name ?? "Built-in"}</span>
            </span>
            <ComfyStatusLine ready={gen ? ready : undefined} />
          </div>
        }
      />
      <PageBody width="wide" className="pb-0">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_30rem] lg:items-start">
          {/* The run bar pins to the bottom of the view; long layers scroll above it. */}
          <div className="flex min-w-0 flex-col gap-4 lg:min-h-[calc(100dvh-5.5rem)]">
            <div className="flex flex-col" aria-label="Positive prompt">
              {form.blocks.map((blk, i) => (
                <div key={"id" in blk ? blk.id : blk.kind}>
                  {i > 0 && (
                    <AddLayer onAdd={(k) => set("blocks", insertBlock(form.blocks, i, k))} onCharacter={addCharacter} />
                  )}
                  {blk.kind === "prefix" ? (
                    <LayerRow label="Prefix">
                      <PresetControl kind="positive" value={form.prefix} onChange={(v) => set("prefix", v)} presets={presets} label="Prefix preset" />
                    </LayerRow>
                  ) : blk.kind === "character" ? (
                    <CharacterLayer
                      value={form.characters}
                      onChange={(v) => set("characters", v)}
                      adding={addingCharacter}
                      onAdded={() => setAddingCharacter(false)}
                      installedLoras={models?.loras ?? NO_STRINGS}
                      rejectedLoras={flagged.loras}
                    />
                  ) : blk.kind === "prompt" ? (
                    <Card
                      className={cn(
                        "px-4 pb-3 pt-3.5 ring-1 ring-brand-700/70 shadow-[0_0_0_3px_rgb(110_82_214/0.15)]",
                        rejected?.some((e) => e.field === "positive") && "ring-red-700",
                      )}
                    >
                      <div className="mb-1.5 text-sm font-semibold text-neutral-50">Prompt</div>
                      <PromptInput
                        label="Prompt"
                        value={form.prompt}
                        onChange={(v) => set("prompt", v)}
                        suggestions={pool}
                        embeddings={models?.embeddings ?? NO_STRINGS}
                        rows={6}
                        placeholder="Scene, pose, lighting"
                        className="text-[15px] leading-relaxed"
                        marks={counts?.marks}
                        fix={countFix}
                      />
                    </Card>
                  ) : blk.kind === "style" ? (
                    <StyleLayer
                      value={form.loras}
                      onChange={(v) => set("loras", v)}
                      installed={models?.loras ?? NO_STRINGS}
                      usage={usage}
                      invalid={flagged.loras}
                      presets={loraPresets}
                    />
                  ) : blk.kind === "text" ? (
                    <TextLayer
                      value={blk.text}
                      onChange={(text) => set("blocks", updateBlock(form.blocks, blk.id, { text }))}
                      onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}
                    />
                  ) : blk.kind === "preset" ? (
                    <LayerRow label="Preset" onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}>
                      <PresetControl
                        kind="positive"
                        value={blk.preset}
                        onChange={(preset) => set("blocks", updateBlock(form.blocks, blk.id, { preset }))}
                        presets={presets}
                        label="Preset"
                      />
                    </LayerRow>
                  ) : (
                    <EmbeddingLayer
                      value={blk.name}
                      onChange={(name) => set("blocks", updateBlock(form.blocks, blk.id, { name }))}
                      onRemove={() => set("blocks", removeBlock(form.blocks, blk.id))}
                      embeddings={models?.embeddings ?? NO_STRINGS}
                    />
                  )}
                </div>
              ))}
              <AddLayer
                onAdd={(k) => set("blocks", insertBlock(form.blocks, form.blocks.length, k))}
                onCharacter={addCharacter}
              />
              <NegativeLayer
                preset={form.negativePreset}
                onPreset={(v) => set("negativePreset", v)}
                presets={presets}
                hasText={!!form.negative.trim()}
              >
                <PromptInput
                  label="Negative prompt"
                  value={form.negative}
                  onChange={(v) => set("negative", v)}
                  suggestions={pool}
                  embeddings={models?.embeddings ?? NO_STRINGS}
                  rows={2}
                  placeholder="More to avoid"
                  invalid={rejected?.some((e) => e.field === "negative")}
                  className="text-sm"
                />
              </NegativeLayer>
            </div>
            <details className="rounded-lg border border-line bg-neutral-950/40 px-4 py-2.5 text-sm">
              <summary className="cursor-pointer text-muted">Prompt as sent</summary>
              <div className="mt-2 space-y-2 font-mono text-xs text-neutral-300 break-words">
                <p>{positive || "(empty)"}</p>
                <p className="text-faint">{negative || "(no negative)"}</p>
                {sentLoras.length > 0 && (
                  <p className="text-muted">
                    {sentLoras.map((l) => `<lora:${stemOf(l.name)}:${l.strength}>`).join(" ")}
                  </p>
                )}
              </div>
            </details>
            <div className="flex-1" />
            <div className="sticky bottom-0 z-[5] -mx-2 bg-gradient-to-t from-canvas from-80% to-transparent px-2 pb-4 pt-3">
              <Card className="space-y-3 p-4 shadow-panel">
                {gen && !ready && <TestRunCard checkpoint={form.checkpoint} disabled={!connected} />}
                <div
                  className={cn(
                    "grid grid-cols-2 items-start gap-3",
                    ownBatchSize ? "md:grid-cols-4" : "md:grid-cols-3",
                    hasSampling
                      ? "2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1.6fr)_auto_minmax(0,0.9fr)]"
                      : "2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_auto_minmax(0,0.9fr)]",
                  )}
                >
                  <CheckpointPicker
                    value={form.checkpoint}
                    options={checkpoints}
                    onChange={(v) => set("checkpoint", v)}
                    invalid={flagged.checkpoint ? "Not in ComfyUI's checkpoint list" : null}
                  />
                  {gen && hasSampling && (
                    <SamplingControl
                      value={form.sampling}
                      defaults={gen.sampling}
                      samplers={models?.samplers ?? NO_STRINGS}
                      schedulers={models?.schedulers ?? NO_STRINGS}
                      onChange={(v) => set("sampling", v)}
                      invalid={flagged.sampling ? "ComfyUI refused these sampler settings" : null}
                    />
                  )}
                  <SizePicker value={{ width: form.width, height: form.height }} onChange={(sz) => setForm((f) => ({ ...f, ...sz }))} />
                  <SeedControl value={form.seed} onChange={(v) => set("seed", v)} />
                  <CountStepper
                    value={form.count}
                    onChange={(v) => set("count", v)}
                    mode={countMode}
                    className={ownBatchSize ? "col-span-2 2xl:col-span-1" : undefined}
                    batchSize={
                      ownBatchSize ? { value: form.perRequest, default: defaultPerRequest, onChange: (n) => set("perRequest", n) } : null
                    }
                  />
                  <BatchName auto={autoName} custom={form.name} onChange={(v) => set("name", v)} />
                </div>
                {rejected && (
                  <RejectedBox
                    errors={rejected}
                    onRefresh={() => refresh.mutate()}
                    onDismiss={() => setRejected(null)}
                    refreshing={refresh.isPending}
                  />
                )}
                {blocked ? (
                  <Button
                    className="w-full h-11 text-[15px]"
                    disabled
                    title={!ready && connected ? "Use Test run above: one image proves the checkpoint and the output folder" : undefined}
                  >
                    {blocked === "Run the test first" ? <FlaskConical size={16} /> : <Lock size={16} />}
                    {blocked}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="w-full h-11 text-[15px]"
                    disabled={!canQueue}
                    onClick={() => queue.mutate()}
                    title={queueTitle(estimate)}
                  >
                    {queue.isPending ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                    Queue {form.count} {form.count === 1 ? "image" : "images"}
                  </Button>
                )}
              </Card>
            </div>
          </div>

          <aside
            className="space-y-4 pb-6 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto"
            aria-label="Output"
          >
            {/* Narrow screens: the Queue button's tooltip says it instead. */}
            <div className="hidden lg:block">
              <NextBatch
                estimate={estimate}
                generator={gen?.name ?? "Built-in"}
                checkpoint={form.checkpoint}
                count={form.count}
                ratio={form.width && form.height ? form.width / form.height : 2 / 3}
              />
            </div>
            {status && (
              // Other batches still running or waiting; the newest shows below with its images.
              <QueueCard active={status.active.filter((x) => x._id !== newest?.[0]?._id)} connected={connected} />
            )}
            <LatestResults />
            <RecentBatches onOpen={(id) => navigate(`/generations/${id}`)} />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
