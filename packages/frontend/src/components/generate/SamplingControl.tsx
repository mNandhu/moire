import { useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { ChevronDown, RotateCcw } from "lucide-react";
import { cn } from "../../lib/cn";
import { Picker, type PickerOption } from "../ui";
import type { Sampling } from "../../lib/generate";
import { CFG_RANGE, STEPS_RANGE } from "../../lib/generationLimits";
import { samplerLabel, samplingLabel } from "../../lib/generateForm";
import { FieldLabel, NumberStepper } from "./fields";

/**
 * Sampler, scheduler, steps and CFG behind one field that shows them in a
 * line. `value` holds only what the user changed; `defaults` is the
 * Generator's graph, shown for the rest.
 */
export function SamplingControl({
  value,
  defaults,
  samplers,
  schedulers,
  onChange,
  invalid,
}: {
  value: Sampling;
  defaults: Sampling;
  samplers: readonly string[];
  schedulers: readonly string[];
  onChange: (s: Sampling) => void;
  invalid?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const shown = { ...defaults, ...value };
  const changed = Object.keys(value).length > 0;
  const patch = (p: Sampling) => {
    const next = { ...value, ...p };
    // Back at the Generator's own value: no longer a change.
    for (const k of Object.keys(p) as (keyof Sampling)[]) if (next[k] === defaults[k]) delete next[k];
    onChange(next);
  };
  const dismiss = useDismiss(wrapRef, () => setOpen(false), open);
  const options = (names: readonly string[], current: string | undefined, label: (n: string) => string): PickerOption[] => {
    const list = current && !names.includes(current) ? [current, ...names] : names;
    return list.map((n) => ({ value: n, label: label(n), detail: label(n) !== n ? n : undefined }));
  };
  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={dismiss.onKeyDown}
    >
      <FieldLabel>Sampling</FieldLabel>
      <button
        type="button"
        aria-label="Sampling"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={invalid ?? samplingLabel(shown)}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "sampling-field flex h-9 w-full items-center gap-2 rounded-lg border border-line bg-canvas px-3 text-left text-sm hover:border-line-strong",
          invalid && "ring-1 ring-red-700",
        )}
      >
        {/* The sampler gives way when space is short; steps and CFG never
            truncate, and drop their words when the field is narrow. */}
        <span className={cn("min-w-0 flex-1 truncate", changed ? "text-neutral-100" : "text-muted")}>
          {shown.sampler ? samplerLabel(shown.sampler) : samplingLabel({ scheduler: shown.scheduler }) || "Default"}
        </span>
        {(shown.steps != null || shown.cfg != null) && (
          <span className="shrink-0 whitespace-nowrap tabular-nums text-muted">
            {shown.steps != null && (
              <>
                {shown.steps}
                <span className="sampling-unit"> steps</span>
              </>
            )}
            {shown.steps != null && shown.cfg != null && <span className="text-faint"> · </span>}
            {shown.cfg != null && (
              <>
                <span className="sampling-unit">CFG </span>
                {shown.cfg}
              </>
            )}
          </span>
        )}
        <ChevronDown size={16} className={cn("shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div data-popup className="absolute bottom-full left-0 z-50 mb-1 w-80 max-w-[90vw] space-y-3 rounded-lg border border-line-strong bg-raised p-3 shadow-panel">
          {"sampler" in defaults && (
            <div>
              <FieldLabel>Sampler</FieldLabel>
              <Picker
                aria-label="Sampler"
                value={shown.sampler ?? ""}
                options={options(samplers, shown.sampler, (n) => samplerLabel(n))}
                onChange={(v) => patch({ sampler: v })}
                searchable
                className="w-full"
                side="up"
              />
            </div>
          )}
          {"scheduler" in defaults && (
            <div>
              <FieldLabel>Scheduler</FieldLabel>
              <Picker
                aria-label="Scheduler"
                value={shown.scheduler ?? ""}
                options={options(schedulers, shown.scheduler, (n) => n.replace(/_/g, " "))}
                onChange={(v) => patch({ scheduler: v })}
                className="w-full"
                side="up"
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            {"steps" in defaults && (
              <NumberStepper label="Steps" value={shown.steps} onChange={(n) => patch({ steps: n })} step={1} min={STEPS_RANGE[0]} max={STEPS_RANGE[1]} />
            )}
            {"cfg" in defaults && (
              <NumberStepper label="CFG" value={shown.cfg} onChange={(n) => patch({ cfg: n })} step={0.5} min={CFG_RANGE[0]} max={CFG_RANGE[1]} />
            )}
          </div>
          {changed && (
            <button
              type="button"
              onClick={() => onChange({})}
              title={samplingLabel(defaults)}
              className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-neutral-100"
            >
              <RotateCcw size={12} />
              Workflow's settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}
