import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Shuffle, Wand2, X } from "lucide-react";
import { Badge, Button, DropdownMenu } from "../ui";
import { cn } from "../../lib/cn";
import { thumbUrl, useGenerators, type Generator, type RemixDoc } from "../../lib/generate";
import { formFromRemix, loadDraft, saveDraft, type GenerateForm, type SeedChoice } from "../../lib/generateForm";
import { generatorFor, InGenerateBadge } from "./InGenerate";
import { TestBadge } from "./WorkflowPicker";

/** How Generate is told about a remix made while it is mounted (the viewer
 * can sit over it): router state, read once. */
export type RemixState = { remixForm: GenerateForm };

/** The image's workflow as set up in Generate, if it is: for an image Moiré
 * queued, the workflow its batch ran. */
export function useRemixWorkflow(doc: RemixDoc | undefined) {
  const { data: generators } = useGenerators();
  const w = doc?.workflow;
  const ran = doc?.batch ? generators?.find((g) => g._id === doc.batch!.generator_id) : undefined;
  const gen = ran ?? (w ? generatorFor(generators, { sig: w.workflow_sig, family: w.family }) : undefined);
  return { generators, gen };
}

/** The viewer's Workflow line: the workflow's name, In Generate, and Use /
 * Set up this workflow. */
export function WorkflowLine({ doc, imageId }: { doc: RemixDoc; imageId: string }) {
  const { generators, gen } = useRemixWorkflow(doc);
  const w = doc.workflow!;
  const name = gen?.name ?? w.family_name ?? w.file_name ?? "Unnamed workflow";
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-xs font-medium text-muted">Workflow</span>
      <span className="min-w-0 truncate text-neutral-100" title={name}>
        {name}
      </span>
      {w.family && <InGenerateBadge generators={generators} family={w.family} />}
      <Link
        to={gen ? `/generate?workflow=${encodeURIComponent(gen._id)}` : `/generate/workflows/new?image=${encodeURIComponent(imageId)}`}
        className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
      >
        <Wand2 size={12} /> {gen ? "Use this workflow" : "Set up this workflow"}
      </Link>
    </div>
  );
}

function SeedSwitch({ value, onChange }: { value: SeedChoice; onChange: (v: SeedChoice) => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-xs font-medium text-muted">Seed</span>
      <div role="radiogroup" aria-label="Seed" className="inline-flex gap-0.5 rounded-lg border border-line bg-canvas p-0.5">
        {(["same", "new"] as const).map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => onChange(v)}
            className={cn(
              "h-6 rounded-md px-2.5 text-xs",
              value === v ? "bg-raised text-neutral-50" : "text-muted hover:text-neutral-100",
            )}
          >
            {v === "same" ? "Same" : "New"}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Remix: start Generate from this image. With its workflow set up the menu
 * offers that one and Built-in, with Same / New seed; without, Built-in only.
 * An image without a ComfyUI workflow goes straight to Built-in.
 */
export function RemixButton({ doc }: { doc: RemixDoc }) {
  const navigate = useNavigate();
  const { generators, gen } = useRemixWorkflow(doc);
  // The same seed only repeats the image on its own workflow.
  const [seed, setSeed] = useState<SeedChoice | null>(null);
  const seedChoice: SeedChoice = seed ?? (gen?.ready || doc.batch ? "same" : "new");
  const builtin = generators?.find((g) => g.kind === "builtin");
  const go = (target: Generator, s: SeedChoice) => {
    const form = formFromRemix(doc, target, s, loadDraft());
    saveDraft(form);
    navigate("/generate", { state: { remixForm: form } satisfies RemixState });
  };
  if (!builtin) return null;
  const label = (
    <>
      <Shuffle size={13} /> Remix
    </>
  );
  if (!doc.workflow) {
    return (
      <Button size="sm" variant="primary" onClick={() => go(builtin, "new")}>
        {label}
      </Button>
    );
  }
  const items = [
    ...(gen && gen.kind !== "builtin" ? [{ label: `Remix with ${gen.name}`, hint: <TestBadge gen={gen} />, onClick: () => go(gen, seedChoice) }] : []),
    { label: "Remix with Built-in", onClick: () => go(builtin, seedChoice) },
  ];
  return (
    <DropdownMenu
      size="sm"
      variant="primary"
      label={label}
      items={items}
      footer={<SeedSwitch value={seedChoice} onChange={setSeed} />}
    />
  );
}

/** Generate's "Remixing an image" strip, until cleared. */
export function RemixStrip({ remix, onClear }: { remix: NonNullable<GenerateForm["remix"]>; onClear: () => void }) {
  const to = `/image/${encodeURIComponent(remix.image)}`;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-brand-600/60 bg-surface px-3 py-2">
      <img src={thumbUrl(remix.image)} alt="" className="h-11 w-8 shrink-0 rounded-md object-cover" />
      <span className="text-sm text-neutral-50">Remixing an image</span>
      <Badge tone="neutral">{remix.seed != null ? `Same seed ${remix.seed}` : "New seed"}</Badge>
      <Link to={to} className="text-sm text-brand-300 hover:text-brand-200">
        Open it
      </Link>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X size={14} /> Clear
      </Button>
    </div>
  );
}
