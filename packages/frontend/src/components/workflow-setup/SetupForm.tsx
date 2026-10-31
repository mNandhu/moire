import { useState } from "react";
import { Check, CircleAlert, Loader2 } from "lucide-react";
import { Badge, Button, Card, Checkbox, Input, Tooltip } from "../ui";
import { cn } from "../../lib/cn";
import type { GeneratorSetup, GeneratorSlots } from "../../lib/generate";
import {
  SAMPLING_KEYS,
  canSave,
  checklist,
  finalSlots,
  groupTicked,
  leaveOut,
  pathKey,
  tickGroup,
} from "../../lib/generatorSetup";
import { stemOf } from "../../lib/modelNames";
import { PromptSlot } from "./PromptSlot";
import { NumberStepper } from "../generate/fields";
import { PER_REQUEST_MAX } from "../../lib/generationLimits";
import { NodeLine, SlotCard } from "./SlotCard";

/** The setup form for a discovered graph: slots, name, checklist, Save. */
export function SetupForm({
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
    onSave({ name: name.trim() || initialName, slots: finalSlots(slots, lorasOn, lora), defaults: { base, negative } });
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
            title="Images per run"
            badge={slots.batch_size ? <Badge tone="success">Found</Badge> : <Badge>Set in the workflow</Badge>}
          >
            {slots.batch_size ? (
              <NumberStepper
                label="Images per run"
                hideLabel
                compact
                value={slots.per_request ?? 1}
                onChange={(n) => setSlots({ ...slots, per_request: n })}
                step={1}
                min={1}
                max={PER_REQUEST_MAX}
              />
            ) : (
              <p className="text-xs text-muted">Count in Generate is in runs.</p>
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
            badge={SAMPLING_KEYS.some((k) => slots[k]) ? <Badge tone="success">Found</Badge> : <Badge>Set in the workflow</Badge>}
          >
            <p className="text-xs text-muted">
              {SAMPLING_KEYS.filter((k) => slots[k]).join(", ") || "Nothing Generate can change"}
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
            lora ? (
              <Checkbox checked={lorasOn} onChange={setLorasOn} label={<span className="text-xs">Let Moiré add LoRAs</span>} />
            ) : (
              <Checkbox
                checked={!!slots.lora_text}
                onChange={(on) => setSlots((s) => ({ ...s, lora_text: on || undefined }))}
                label={<span className="text-xs">Write LoRAs into the prompt</span>}
              />
            )
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
          ) : slots.lora_text ? (
            <p className="text-xs text-muted">LoRAs go into the positive prompt as &lt;lora:name:strength&gt; tags.</p>
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
                    {stemOf(l.name)}
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
