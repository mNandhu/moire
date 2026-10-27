import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Wand2 } from "lucide-react";
import { ButtonLink, EmptyState, PageBody, PageHeader } from "../components/ui";
import { bareTagPool } from "../components/generate/ChipInput";
import { stemOf } from "../lib/modelNames";
import { ComfyStatusLine } from "../components/generate/ComfyStatusLine";
import { WorkflowPicker } from "../components/generate/WorkflowPicker";
import { RemixStrip, type RemixState } from "../components/generate/Remix";
import { blockedReason, countModeOf, defaultBatchSize, forWorkflow, runBarOf } from "../lib/generatorRunBar";
import { useCharacters } from "../lib/queries";
import { useNextEstimate } from "../components/generate/NextBatch";
import { QueueDeck } from "../components/generate/QueueDeck";
import { OutputFeed } from "../components/generate/OutputFeed";
import { PositiveLayers } from "../components/generate/PositiveLayers";
import { RunBar } from "../components/generate/RunBar";
import { autoBatchName } from "../lib/batchName";
import {
  MODELS_KEY,
  RejectedError,
  invalidateQueue,
  queueBatch,
  refreshModels,
  useComfyModels,
  useComfySettings,
  fetchDefaultOutfit,
  DEFAULT_OUTFIT,
  DEFAULT_OUTFIT_NAME,
  useComfyStatus,
  useGenerators,
  useLoraPresets,
  usePresets,
  useRecipes,
  type CharacterInput,
  type NodeError,
} from "../lib/generate";
import { nameWords, previewText, toParts, toEstimateBody, toQueueBody, type GenerateForm } from "../lib/generateForm";
import { loadDraft, saveDraft } from "../lib/generateDraft";
import { settleFresh, switchWorkflow } from "../lib/composerEdits";
import { boardLayersOf } from "../lib/boardLayers";
import { rejectedFields } from "../lib/sampling";
import { checkCountTags, countRanges, expectedTags, fixCountTags, followCast, type Kind } from "../lib/countTags";
import type { CountMode } from "../lib/requests";
import { PromptInput, type PromptFlash } from "../components/generate/PromptInput";
import { characterPageQuery, useTagAggregate } from "../lib/queries";
import { characterColours, displayName, mixColours } from "../lib/character";
import { useAmbientTint } from "../lib/ambient";
import { characterInput, characterTags } from "../lib/recipe";
import { outfitInput, pickOf, wornTags, type OutfitPick } from "../lib/outfit";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useToast } from "../components/Toasts";

const NO_STRINGS: string[] = [];

/** "Eula", "Eula and Furina", "Eula, Furina and Zhongli". */
function andList(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
  const { data: presets } = usePresets();
  const { data: loraPresets } = useLoraPresets();
  const { data: tagAgg } = useTagAggregate({ includePrompt: true });
  const [form, setForm] = useState<GenerateForm>(() => loadDraft());
  const [rejected, setRejected] = useState<NodeError[] | null>(null);
  // The "+" between layers asked for another character: the Character layer
  // shows a row with its picker open.
  const [addingCharacter, setAddingCharacter] = useState(false);
  const set = <K extends keyof GenerateForm>(k: K, v: GenerateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  // Characters just picked (here or from a character page) start wearing
  // what Settings says: none unless set to their usual clothes. A remix
  // or a replayed batch brings its own and marks none.
  const startAs = settings?.new_character_outfit;
  useEffect(() => {
    if (!form.fresh.length || !startAs) return;
    const settle = (tag: string, pick: OutfitPick | null) => setForm((f) => settleFresh(f, tag, pick));
    for (const tag of form.fresh) {
      if (startAs !== "default") {
        settle(tag, null);
        continue;
      }
      // Its own request, not the picker's query: that one's observer
      // unmounting cancels a fetch shared through the query cache.
      void fetchDefaultOutfit(tag)
        .then((o) => settle(tag, o.tags.length ? pickOf(o) : null))
        .catch(() => settle(tag, null));
    }
  }, [form.fresh, startAs]);

  useEffect(() => saveDraft(form), [form]);
  // A remix made from the viewer while this page sat under it: the page
  // stayed mounted, so the draft it saved isn't read again.
  const location = useLocation();
  const remixed = (location.state as RemixState | null)?.remixForm;
  useEffect(() => {
    if (!remixed) return;
    setForm(remixed);
    navigate(".", { replace: true, state: null });
  }, [remixed, navigate]);

  // The chosen workflow; one that is gone falls back to the built-in.
  const gen = generators?.find((g) => g._id === form.workflow) ?? generators?.[0];
  const bar = runBarOf(gen);
  // ?workflow=<id> (Use this workflow): choose it once the list has it.
  const [params, setParams] = useSearchParams();
  // Writing in the form: on a phone the keyboard is up, and a pinned Queue
  // bar would ride above it, over the field being typed in.
  const [writing, setWriting] = useState(false);
  const asked = params.get("workflow");
  const chooseWorkflow = (id: string) => {
    const next = generators?.find((g) => g._id === id);
    setForm((f) => switchWorkflow(f, id, next));
  };
  const checkpoints = models?.checkpoints ?? NO_STRINGS;
  // The first installed checkpoint until the user picks one.
  useEffect(() => {
    if (!form.checkpoint && checkpoints.length) set("checkpoint", checkpoints[0]);
  }, [checkpoints, form.checkpoint]);

  useEffect(() => {
    if (!asked || !generators?.some((g) => g._id === asked)) return;
    if (asked !== form.workflow) chooseWorkflow(asked);
    setParams((p) => {
      p.delete("workflow");
      return p;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, generators]);

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
    return r && r.tag === tag ? { ...characterInput(r, labels[i], form.identityOff[tag]), outfit: outfitInput(form.outfits[tag]) } : null;
  });
  const characters = inputs.every((c) => c) ? (inputs as CharacterInput[]) : null;
  const oneWorn = form.characters.length === 1 ? form.outfits[form.characters[0]] : undefined;
  const autoName = autoBatchName({
    number: null,
    generator: gen?.name ?? "Built-in",
    extra: nameWords(form),
    character: labels.length ? labels.join(" & ") : null,
    // As the backend names it: one character's outfit, unless an unrenamed Default.
    outfit:
      oneWorn && oneWorn.name && wornTags(oneWorn).length && !(oneWorn.id === DEFAULT_OUTFIT && oneWorn.name === DEFAULT_OUTFIT_NAME)
        ? oneWorn.name
        : null,
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
  const defaultPerRequest = defaultBatchSize(gen, settings?.builtin_per_request ?? 1);
  // How the backend will split the count, per workflow.
  const countMode: CountMode = countModeOf(gen, form.perRequest, settings?.builtin_per_request ?? 1);
  const setupLink = gen?.kind === "custom" ? { text: "Open its setup", to: `/generate/workflows/${gen._id}` } : undefined;
  const connected = !!status?.connected;

  // Counts presses, so each one starts the "Queued" moment over.
  const [queuedTick, setQueuedTick] = useState(0);
  const [justQueued, setJustQueued] = useState(false);
  useEffect(() => {
    if (!queuedTick) return;
    setJustQueued(true);
    const t = setTimeout(() => setJustQueued(false), 1500);
    return () => clearTimeout(t);
  }, [queuedTick]);
  const queue = useMutation({
    mutationFn: () =>
      queueBatch(forWorkflow(toQueueBody(form, gen?._id ?? "builtin", characters ?? [], presets, loraPresets), bar)),
    onMutate: () => setRejected(null),
    // No toast: the button says so and the batch glows where it lands in the deck.
    onSuccess: () => {
      setQueuedTick((n) => n + 1);
      set("name", null);
      invalidateQueue(qc);
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
    recipes.length && form.characters.every((tag, i) => recipes[i]?.tag === tag)
      ? JSON.stringify(recipes.map((r) => r!.gender))
      : null;
  const counts = useMemo(
    () => (genders ? checkCountTags(form.prompt, JSON.parse(genders) as (Kind | null)[]) : null),
    [form.prompt, genders],
  );

  // The cast's count tags (1girl, solo / 1girl, 1boy / 2girls...) follow the
  // picked characters into the prompt, unless the user wrote their own.
  // Null while a recipe is loading or a gender can't be told.
  const castKey =
    form.characters.length === 0
      ? ""
      : genders && !(JSON.parse(genders) as (Kind | null)[]).includes(null)
        ? expectedTags(JSON.parse(genders) as Kind[]).join(",")
        : null;
  const lastCast = useRef<string[] | null>(null);
  const [flash, setFlash] = useState<PromptFlash | null>(null);
  const [boardGlow, setBoardGlow] = useState<number | null>(null);
  // Before paint: the old tags against the new cast would show the check's
  // amber outline for a frame.
  useLayoutEffect(() => {
    if (castKey == null) return;
    const after = castKey ? castKey.split(",") : [];
    const before = lastCast.current;
    lastCast.current = after;
    // The page opening on a saved draft isn't a change of cast.
    if (before == null) return;
    const was = form.prompt;
    const next = followCast(was, before, after);
    if (next == null) return;
    set("prompt", next);
    const undo = () => set("prompt", was);
    // The words lit with a note to undo them, and the Subject box if it's open.
    setBoardGlow(Date.now());
    setFlash({
      key: Date.now(),
      ranges: countRanges(next).filter((r) => after.includes(r.tag)),
      note: (
        <>
          <Sparkles size={13} className="shrink-0 text-brand-300" />
          <span className="min-w-0 flex-1">For {andList(labels)}</span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              undo();
              setFlash(null);
            }}
            className="rounded px-1.5 py-0.5 text-brand-200 hover:bg-line"
          >
            Undo
          </button>
        </>
      ),
    });
    // Only a change of cast moves the tags; typing in the prompt doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castKey]);

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
    recipes.flatMap((r) => (r ? [characterTags(r, form.identityOff[r.tag]), wornTags(form.outfits[r.tag])] : [])),
  );
  const negative = previewText(parts.negative, []);
  const countFix = counts?.expected?.length
    ? {
        label: `Use ${counts.expected.join(", ")}`,
        apply: () => set("prompt", fixCountTags(form.prompt, counts.expected!)),
      }
    : null;
  const promptEditor = (
    <PromptInput
      label="Prompt"
      value={form.prompt}
      onChange={(v) => set("prompt", v)}
      suggestions={pool}
      embeddings={models?.embeddings ?? NO_STRINGS}
      rows={6}
      placeholder="Scene, pose, lighting"
      // The card is already outlined; no focus ring inside it.
      className="text-[15px] leading-relaxed focus-visible:shadow-none"
      marks={counts?.marks}
      fix={countFix}
      flash={flash}
    />
  );
  const boardLayers = boardLayersOf(parts.positive, recipes, everyone, form, setForm);
  // As the backend merges them: characters' LoRAs first, each file once.
  const sentLoras = [...(characters ?? []).flatMap((c) => (c.lora ? [c.lora] : [])), ...form.loras].filter(
    (l, i, all) => all.findIndex((x) => stemOf(x.name) === stemOf(l.name)) === i,
  );
  const ready = !!gen?.ready;
  const blocked = blockedReason({
    connected,
    ready,
    outputLibraryId: settings?.output_library_id,
    picked: form.characters.length,
    loaded: !!characters,
  });

  return (
    <>
      {/* On the right: which Generator this page runs, then one status, with
          ComfyUI's state and the Generator's test run folded into a word. */}
      <PageHeader title="Generate" width="wide">
        {/* The toolbar slot, not actions: on a phone it is a row of its own,
            the workflow at its start (the name cut short if it must), the
            status at its end. */}
        <div className="flex min-w-0 items-center justify-end gap-x-4 text-sm max-md:justify-between">
          {generators && generators.length > 0 ? (
            <WorkflowPicker generators={generators} value={gen?._id ?? "builtin"} onChange={chooseWorkflow} />
          ) : (
            <span className="text-muted">
              Workflow <span className="font-medium text-neutral-100">Built-in</span>
            </span>
          )}
          <ComfyStatusLine ready={gen ? ready : undefined} />
        </div>
      </PageHeader>
      <PageBody width="wide" className="pb-0">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_30rem] lg:items-start">
          {/* From lg the run bar pins to the bottom of the view; long layers scroll above it. A phone has no room to spare for it. */}
          <div
            className="flex min-w-0 flex-col gap-4 lg:min-h-[calc(100dvh-5.5rem)]"
            onFocus={(e) => setWriting((e.target as HTMLElement).matches("input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable]"))}
            onBlur={() => setWriting(false)}
          >
            {form.remix && <RemixStrip remix={form.remix} seed={form.seed} onClear={() => set("remix", null)} />}
            <PositiveLayers
              form={form}
              setForm={setForm}
              gen={gen}
              bar={bar}
              presets={presets}
              loraPresets={loraPresets}
              models={models}
              usage={usage}
              pool={pool}
              rejected={rejected}
              rejectedLoras={flagged.loras}
              promptEditor={promptEditor}
              boardLayers={boardLayers}
              boardGlow={boardGlow}
              setupLink={setupLink}
              addingCharacter={addingCharacter}
              setAddingCharacter={setAddingCharacter}
            />
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
            <RunBar
              gen={gen}
              bar={bar}
              form={form}
              setForm={setForm}
              models={models}
              flagged={flagged}
              setupLink={setupLink}
              countMode={countMode}
              defaultPerRequest={defaultPerRequest}
              autoName={autoName}
              rejected={rejected}
              onRefresh={() => refresh.mutate()}
              refreshing={refresh.isPending}
              onDismissRejected={() => setRejected(null)}
              writing={writing}
              run={{
                blocked,
                connected,
                pending: queue.isPending,
                justQueued,
                onQueue: () => queue.mutate(),
                estimate,
              }}
            />
          </div>

          <aside
            className="space-y-4 pb-6 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto"
            aria-label="Output"
          >
            <QueueDeck />
            <OutputFeed />
          </aside>
        </div>
      </PageBody>
    </>
  );
}
