import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { galleryHref, type Filters } from "../../lib/imageFilter";
import type { TagWorkflow } from "../../lib/tagBrowse";

export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 items-start">
      <span className="text-xs text-faint leading-6">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function Chip({ to, title, label, share }: { to: string; title: string; label: string; share: string }) {
  return (
    <Link
      to={to}
      title={`${label}: ${title}`}
      className="inline-flex items-baseline gap-1.5 max-w-full h-6 px-2 rounded-full bg-raised border border-line text-xs text-neutral-200 hover:border-line-strong"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-2xs text-faint tabular-nums">{share}</span>
    </Link>
  );
}

/**
 * What the images were made with: LoRAs, embeddings and workflows as chips
 * linking to the gallery (narrowed by `base`), each with its share of
 * `total`. `detailed` adds a LoRA's usual strength and average score.
 * Nothing renders when there are none.
 */
export function MadeWithChips({
  loras,
  embeddings,
  workflows,
  total,
  base,
  heading,
  detailed = false,
}: {
  loras: Array<{ name: string; count: number; strength?: number | null; score?: number | null }>;
  embeddings: Array<{ name: string; count: number }>;
  workflows: readonly TagWorkflow[];
  total: number;
  base?: Partial<Filters>;
  heading: "h2" | "h3";
  detailed?: boolean;
}) {
  if (!loras.length && !embeddings.length && !workflows.length) return null;
  const Heading = heading;
  const share = (n: number) => `${Math.round((n / (total || 1)) * 100)}%`;
  return (
    <section className="space-y-2">
      <Heading className="text-2xs uppercase tracking-wider text-faint">Made with</Heading>
      {loras.length > 0 && (
        <ChipRow label="LoRA">
          {loras.map((l) => {
            const strength = detailed ? (l.strength ?? null) : null;
            const score = detailed ? (l.score ?? null) : null;
            return (
              <Chip
                key={l.name}
                to={galleryHref({ ...base, lora: [l.name] })}
                title={[
                  `${l.count.toLocaleString()} images`,
                  strength !== null && `usually at ${strength}`,
                  score !== null && `average score ${score.toFixed(1)}`,
                ]
                  .filter(Boolean)
                  .join(", ")}
                label={l.name}
                share={[share(l.count), strength !== null && `@${strength}`].filter(Boolean).join(" ")}
              />
            );
          })}
        </ChipRow>
      )}
      {embeddings.length > 0 && (
        <ChipRow label="Embedding">
          {embeddings.map((e) => (
            <Chip
              key={e.name}
              to={galleryHref({ ...base, embedding: [e.name] })}
              title={`${e.count.toLocaleString()} images`}
              label={e.name}
              share={share(e.count)}
            />
          ))}
        </ChipRow>
      )}
      {workflows.length > 0 && (
        <ChipRow label="Workflow">
          {workflows.map((w) => (
            <Chip
              key={JSON.stringify(w.filter)}
              to={galleryHref({ ...base, ...w.filter })}
              title={`${w.count.toLocaleString()} images`}
              label={w.name}
              share={share(w.count)}
            />
          ))}
        </ChipRow>
      )}
    </section>
  );
}
