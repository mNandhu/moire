import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleAlert, FlaskConical, Loader2, Lock, Wand2 } from "lucide-react";
import { Button, Card } from "../ui";
import { BatchName, CheckpointPicker, CountStepper, FixedValue, SeedControl, SizePicker } from "./fields";
import { SamplingControl } from "./SamplingControl";
import { stemOf } from "../../lib/modelNames";
import { canRunTest, testState, type RunBar as RunBarSlots } from "../../lib/generatorRunBar";
import { GENERATORS_KEY, RejectedError, refreshModels, startTest, type ComfyModels, type Generator, type NodeError } from "../../lib/generate";
import type { GenerateForm } from "../../lib/generateForm";
import { queueTitle, type NewEstimate } from "../../lib/eta";
import { etaShort } from "../../lib/format";
import { cn } from "../../lib/cn";
import { countText, type CountMode } from "../../lib/requests";

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
function TestRunCard({ gen, checkpoint, disabled }: { gen: Generator; checkpoint: string | null; disabled: boolean }) {
  const qc = useQueryClient();
  const [errors, setErrors] = useState<NodeError[] | null>(null);
  const run = useMutation({
    mutationFn: () => startTest(gen._id, checkpoint),
    onMutate: () => setErrors(null),
    onError: (e) => {
      if (e instanceof RejectedError) setErrors(e.nodeErrors);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: GENERATORS_KEY }),
  });
  const t = gen.test;
  const state = testState(gen);
  const running = state === "running";
  const waiting = state === "waiting";
  const failed = state === "failed";
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-neutral-100">Test run</div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => run.mutate()}
          disabled={disabled || !canRunTest(state) || run.isPending}
          title={disabled ? "Waiting for connection" : "One image at the chosen checkpoint"}
        >
          {(running || run.isPending) && <Loader2 size={14} className="animate-spin" />}
          {running ? "Running" : waiting || failed ? "Run again" : "Test run"}
        </Button>
      </div>
      {failed && t?.error && (
        <div className="mt-2 font-mono text-xs text-red-300">
          {t.error.class_type} {t.error.node && `node ${t.error.node}`}: {t.error.message}
        </div>
      )}
      {failed && !t?.error && t?.state !== "done" && <div className="mt-2 text-xs text-red-300">{t?.state === "lost" ? "Lost" : "Cancelled"}</div>}
      {failed && t?.state === "done" && <div className="mt-2 text-xs text-red-300">Returned 0 images</div>}
      {waiting && <div className="mt-2 text-xs text-muted">Waiting for the library scan</div>}
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

type RunButtonProps = {
  /** Why Queue can't run yet (blockedReason), said on the button itself. */
  blocked: string | null;
  ready: boolean;
  connected: boolean;
  pending: boolean;
  justQueued: boolean;
  onQueue: () => void;
  estimate: NewEstimate | undefined;
  count: number;
  countMode: CountMode;
};

function RunButton({ blocked, ready, connected, pending, justQueued, onQueue, estimate, count, countMode }: RunButtonProps) {
  const canQueue = !blocked && !pending;
  return blocked ? (
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
      onClick={onQueue}
      title={queueTitle(estimate)}
    >
      {pending ? (
        <Loader2 size={16} className="animate-spin" />
      ) : justQueued ? (
        <Check size={16} />
      ) : (
        <Wand2 size={16} />
      )}
      {justQueued && !pending ? (
        "Queued"
      ) : (
        <>
          Queue {countText(count, countMode)}
          {estimate?.seconds != null && <span className="font-normal tabular-nums opacity-70">~{etaShort(estimate.seconds)}</span>}
        </>
      )}
    </Button>
  );
}

/** The settings card and the Queue button. One button, two places: in the
 * settings card from lg, pinned to the bottom of the screen on phones so it
 * never sits a long scroll away. */
export function RunBar({
  gen,
  bar,
  form,
  setForm,
  models,
  flagged,
  setupLink,
  countMode,
  defaultPerRequest,
  autoName,
  rejected,
  onRefresh,
  refreshing,
  onDismissRejected,
  writing,
  run,
}: {
  gen: Generator | undefined;
  bar: RunBarSlots;
  form: GenerateForm;
  setForm: React.Dispatch<React.SetStateAction<GenerateForm>>;
  models: ComfyModels | undefined;
  flagged: { checkpoint: boolean; sampling: boolean };
  setupLink: { text: string; to: string } | undefined;
  countMode: CountMode;
  defaultPerRequest: number;
  autoName: string;
  rejected: NodeError[] | null;
  onRefresh: () => void;
  refreshing: boolean;
  onDismissRejected: () => void;
  /** Writing in the form: the phone's pinned button lets go. */
  writing: boolean;
  /** The Queue button's state; the rest it reads from the form. */
  run: Omit<RunButtonProps, "count" | "countMode">;
}) {
  const set = <K extends keyof GenerateForm>(k: K, v: GenerateForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { ready, connected } = run;
  const hasSampling = bar.sampling;
  const ownBatchSize = bar.batchSize;
  const checkpoints = models?.checkpoints ?? NO_STRINGS;
  const runButton = <RunButton {...run} count={form.count} countMode={countMode} />;
  return (
    <>
      <div className="lg:sticky bottom-0 z-[5] -mx-2 bg-gradient-to-t from-canvas from-80% to-transparent px-2 pb-4 pt-3">
        <Card className="space-y-3 p-4 shadow-panel">
          {gen && !ready && (
            <TestRunCard gen={gen} checkpoint={bar.checkpoint ? form.checkpoint : null} disabled={!connected} />
          )}
          <div
            className={cn(
              "grid grid-cols-2 items-start gap-3",
              ownBatchSize ? "md:grid-cols-4" : "md:grid-cols-3",
              hasSampling
                ? "2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,1.6fr)_auto_minmax(0,0.9fr)]"
                : "2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_auto_minmax(0,0.9fr)]",
            )}
          >
            {bar.checkpoint ? (
              <CheckpointPicker
                value={form.checkpoint}
                options={checkpoints}
                onChange={(v) => set("checkpoint", v)}
                invalid={flagged.checkpoint ? "Not in ComfyUI's checkpoint list" : null}
              />
            ) : (
              <FixedValue
                label="Checkpoint"
                value={gen?.fixed.checkpoint ? stemOf(gen.fixed.checkpoint) : null}
                why={`${gen?.name ?? "This workflow"} loads its checkpoint itself. To choose one here, map its checkpoint in the workflow's setup.`}
                fix={setupLink}
              />
            )}
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
            {bar.size ? (
              <SizePicker value={{ width: form.width, height: form.height }} onChange={(sz) => setForm((f) => ({ ...f, ...sz }))} />
            ) : (
              <FixedValue
                label="Size"
                value={gen?.fixed.size?.replace("x", "×")}
                why={`${gen?.name ?? "This workflow"} sets its own image size. To choose it here, map its width and height in the workflow's setup.`}
                fix={setupLink}
              />
            )}
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
              onRefresh={onRefresh}
              onDismiss={onDismissRejected}
              refreshing={refreshing}
            />
          )}
          <div className="hidden lg:block">{runButton}</div>
        </Card>
      </div>
      <div className={cn("lg:hidden -mx-2 px-2 pb-3 pt-4", !writing && "sticky bottom-0 z-[5] bg-gradient-to-t from-canvas from-60% to-transparent")}>
        {runButton}
      </div>
    </>
  );
}
