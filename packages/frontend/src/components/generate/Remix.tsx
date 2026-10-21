import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Shuffle, Wand2, X } from "lucide-react";
import { Badge, Button, DropdownMenu } from "../ui";
import { cn } from "../../lib/cn";
import { fetchRemix, remixKey, thumbUrl, useGenerators, type Generator, type RemixInfo } from "../../lib/generate";
import { formFromRemix, loadDraft, saveDraft, type GenerateForm, type SeedChoice } from "../../lib/generateForm";
import { generatorFor, InGenerateBadge } from "./InGenerate";
import { useToast } from "../Toasts";
import { TestBadge } from "./WorkflowPicker";

/** How Generate is told about a remix made while it is mounted (the viewer
 * can sit over it): router state, read once. */
export type RemixState = { remixForm: GenerateForm };

/** The image's workflow as set up in Generate, if it is: for an image Moiré
 * queued, the workflow its batch ran. `exact`: that workflow is the very
 * version that made the image, so the same seed can repeat it (one set up
 * from another version of the family only shares the name). */
export function useRemixWorkflow(info: RemixInfo) {
  const { data: generators } = useGenerators();
  const w = info.workflow;
  const ran = info.batch ? generators?.find((g) => g._id === info.batch!.generator_id) : undefined;
  const sameVersion = w?.workflow_sig ? generatorFor(generators, { sig: w.workflow_sig }) : undefined;
  const gen = ran ?? sameVersion ?? (w?.family ? generatorFor(generators, { family: w.family }) : undefined);
  return { generators, gen, exact: !!gen && (gen === ran || gen === sameVersion) };
}

/** The viewer's Workflow line: the workflow's name, In Generate, and Use /
 * Set up this workflow. */
export function WorkflowLine({ info, imageId }: { info: RemixInfo; imageId: string }) {
  const { generators, gen } = useRemixWorkflow(info);
  const w = info.workflow!;
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
 * An image without a ComfyUI workflow goes straight to Built-in. The full
 * read (prompt split, settings checked) happens on the click.
 */
export function RemixButton({ info }: { info: RemixInfo }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { generators, gen, exact } = useRemixWorkflow(info);
  // The same seed only repeats the image on the workflow version that made it.
  const [seed, setSeed] = useState<SeedChoice | null>(null);
  const seedChoice: SeedChoice = seed ?? (exact && gen?.ready ? "same" : "new");
  const builtin = generators?.find((g) => g.kind === "builtin");
  const go = async (target: Generator, s: SeedChoice) => {
    try {
      const doc = await qc.fetchQuery({ queryKey: remixKey(info.image_id, true), queryFn: () => fetchRemix(info.image_id) });
      const form = formFromRemix(doc, target, s, loadDraft());
      saveDraft(form);
      navigate("/generate", { state: { remixForm: form } satisfies RemixState });
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't read this image", "error");
    }
  };
  if (!builtin) return null;
  const label = (
    <>
      <Shuffle size={13} /> Remix
    </>
  );
  if (!info.workflow) {
    return (
      <Button size="sm" variant="primary" onClick={() => void go(builtin, "new")}>
        {label}
      </Button>
    );
  }
  const items = [
    ...(gen && gen.kind !== "builtin"
      ? [{ label: `Remix with ${gen.name}`, hint: <TestBadge gen={gen} />, onClick: () => void go(gen, seedChoice) }]
      : []),
    { label: "Remix with Built-in", onClick: () => void go(builtin, seedChoice) },
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
export function RemixStrip({
  remix,
  seed,
  onClear,
}: {
  remix: NonNullable<GenerateForm["remix"]>;
  /** The form's seed now: the badge follows edits to it. */
  seed: GenerateForm["seed"];
  onClear: () => void;
}) {
  const to = `/image/${encodeURIComponent(remix.image)}`;
  const same = seed.mode === "fixed" && seed.value != null && seed.value === remix.seed;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-brand-600/60 bg-surface px-3 py-2">
      <img src={thumbUrl(remix.image)} alt="" className="h-11 w-8 shrink-0 rounded-md object-cover" />
      <span className="text-sm text-neutral-50">Remixing an image</span>
      <Badge tone="neutral">
        {same ? `Same seed ${remix.seed}` : seed.mode === "fixed" && seed.value != null ? `Seed ${seed.value}` : "New seed"}
      </Badge>
      <Link to={to} className="text-sm text-brand-300 hover:text-brand-200">
        Open it
      </Link>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X size={14} /> Clear
      </Button>
    </div>
  );
}
