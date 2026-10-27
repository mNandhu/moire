import { Card } from "../ui";
import { batchCast, partRows } from "../../lib/batches";
import { displayWord } from "../../lib/compose";
import type { Batch } from "../../lib/generate";
import { samplingLabel } from "../../lib/sampling";
import { stemOf } from "../../lib/modelNames";

/** What a batch was queued with, for its page: workflow, models, cast, the
 * layers' text, size and seeds, then the prompt as sent. */
export function BatchInputs({ b }: { b: Batch }) {
  const i = b.inputs;
  const cast = batchCast(i);
  const row = (k: string, v: React.ReactNode) => (
    <div className="contents">
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 break-words text-neutral-200">{v}</dd>
    </div>
  );
  return (
    <Card className="p-4 text-sm">
      <div className="mb-3 font-medium text-neutral-100">Prompt</div>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        {row("Workflow", b.generator.name ?? b.generator._id)}
        {i.checkpoint && row("Checkpoint", <span className="font-mono">{stemOf(i.checkpoint)}</span>)}
        {i.sampling && Object.keys(i.sampling).length > 0 && row("Sampling", samplingLabel(i.sampling))}
        {cast.map((c) => (
          <div key={c.tag} className="contents">
            {row(
              cast.length > 1 ? c.label || displayWord(c.tag) : "Character",
              <>
                {cast.length === 1 && (c.label || displayWord(c.tag))}
                {c.tags.length > 1 && (
                  <span className="text-muted">
                    {cast.length === 1 && " + "}
                    {c.tags.slice(1).map(displayWord).join(", ")}
                  </span>
                )}
                {c.lora && (
                  <span className="ml-2 font-mono text-muted">
                    {stemOf(c.lora.name)} {c.lora.strength.toFixed(2)}
                  </span>
                )}
              </>,
            )}
          </div>
        ))}
        {i.loras.length > 0 &&
          row(
            cast.length ? "Style LoRAs" : "LoRAs",
            i.loras.map((l) => (
              <span key={l.name} className="mr-2 font-mono">
                {stemOf(l.name)} {l.strength.toFixed(2)}
              </span>
            )),
          )}
        {partRows(i.positive).map((p) => (
          <div key={p.role} className="contents">
            {row(p.label, p.value)}
          </div>
        ))}
        {i.extra.length > 0 && row("Extra", i.extra.map(displayWord).join(", "))}
        {i.width && i.height && row("Size", `${i.width} × ${i.height}`)}
        {i.per_request != null && row("Per run", `${i.per_request} ${i.per_request === 1 ? "image" : "images"}`)}
        {row(
          b.requests.length > 1 ? "Seeds" : "Seed",
          <span className="font-mono" title={b.requests.map((q) => q.seed).join(", ")}>
            {b.requests[0]?.seed}
            {b.requests.length > 1 && <span className="text-muted"> and {b.requests.length - 1} more</span>}
          </span>,
        )}
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted">Prompt as sent</summary>
        <p className="mt-2 break-words font-mono text-xs text-neutral-300">{i.positive_text}</p>
        {i.negative_text && <p className="mt-2 break-words font-mono text-xs text-faint">{i.negative_text}</p>}
      </details>
    </Card>
  );
}
