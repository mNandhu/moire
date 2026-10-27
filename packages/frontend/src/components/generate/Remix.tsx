import { useState } from "react";
import { useThumbUrl } from "../../lib/queries";
import { imageHref } from "../../lib/imageFilter";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Shuffle, Wand2, X } from "lucide-react";
import { Badge, Button, Picker, type PickerOption } from "../ui";
import { cn } from "../../lib/cn";
import { fetchRemix, remixKey, useGenerators, type Generator, type RemixInfo } from "../../lib/generate";
import type { GenerateForm } from "../../lib/generateForm";
import { loadDraft, saveDraft } from "../../lib/generateDraft";
import { formFromRemix, type SeedChoice } from "../../lib/remixForm";
import { generatorFor, InGenerateBadge } from "./InGenerate";
import { useToast } from "../Toasts";
import { TestBadge } from "./TestBadge";

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

function SeedSwitch({ value, onChange, own }: { value: SeedChoice; onChange: (v: SeedChoice) => void; own: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1" title={`For ${own}; other workflows start on a new seed`}>
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
 * Remix: start Generate from this image with any workflow, searchable. Its
 * own workflow (if set up) leads, then the others, Built-in last. Same /
 * New seed applies to its own workflow; another one starts on a new seed.
 * The full read (prompt split, settings checked) happens on the pick.
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
  const own = gen;
  const go = async (target: Generator) => {
    const mine = target === own;
    try {
      const doc = await qc.fetchQuery({ queryKey: remixKey(info.image_id, true), queryFn: () => fetchRemix(info.image_id) });
      const form = formFromRemix(doc, target, mine ? seedChoice : "new", loadDraft(), mine);
      saveDraft(form);
      navigate("/generate", { state: { remixForm: form } satisfies RemixState });
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Couldn't read this image", "error");
    }
  };
  if (!builtin || !generators) return null;
  const others = generators.filter((g) => g.kind !== "builtin" && g !== own);
  const ordered = [...(own ? [own] : []), ...others, ...(own === builtin ? [] : [builtin])];
  const label = (
    <>
      <Shuffle size={13} /> Remix
    </>
  );
  // Built-in alone: nothing to choose.
  if (ordered.length === 1 && !own) {
    return (
      <Button size="sm" variant="primary" onClick={() => void go(builtin)}>
        {label}
      </Button>
    );
  }
  const options: PickerOption[] = ordered.map((g) => ({
    value: g._id,
    label: g.name,
    group: own ? (g === own ? "This image's workflow" : "Other workflows") : undefined,
    // Only a workflow that can't run yet says why.
    hint: g.ready ? undefined : <TestBadge gen={g} />,
  }));
  return (
    <Picker
      value=""
      options={options}
      onChange={(id) => {
        const target = ordered.find((g) => g._id === id);
        if (target) void go(target);
      }}
      aria-label="Remix with"
      searchable
      checks={false}
      align="right"
      trigger={() => (
        <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-transparent bg-brand-600 px-3 text-xs font-medium text-white hover:bg-brand-500">
          {label}
        </span>
      )}
      footer={own && <SeedSwitch value={seedChoice} onChange={setSeed} own={own.name} />}
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
  const to = imageHref(remix.image);
  const thumb = useThumbUrl(remix.image);
  const same = seed.mode === "fixed" && seed.value != null && seed.value === remix.seed;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-brand-600/60 bg-surface px-3 py-2">
      {thumb ? (
        <img src={thumb} alt="" className="h-11 w-8 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="h-11 w-8 shrink-0 rounded-md bg-raised" />
      )}
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
