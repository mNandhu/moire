import { Link } from "react-router-dom";
import { Badge, Tooltip } from "../ui";
import type { Generator } from "../../lib/generate";

/** The set-up workflow made from this version (``sig``) or, failing that,
 * from any version of this family. */
export function generatorFor(
  generators: readonly Generator[] | undefined,
  { sig, family }: { sig?: string | null; family?: string | null },
): Generator | undefined {
  const fromImage = (generators ?? []).filter((g) => g.source?.kind === "image");
  const src = (g: Generator) => (g.source?.kind === "image" ? g.source : null);
  return (
    (sig ? fromImage.find((g) => src(g)?.workflow_sig === sig) : undefined) ??
    (family ? fromImage.find((g) => src(g)?.family === family) : undefined)
  );
}

/**
 * "In Generate": this workflow (family) is set up to run. The tip says which
 * version it was set up from, so an older one shows, and opens it.
 */
export function InGenerateBadge({
  generators,
  family,
  versions,
}: {
  generators: readonly Generator[] | undefined;
  family: string;
  /** The family's version signatures, newest last. */
  versions?: readonly string[];
}) {
  const gen = generatorFor(generators, { family });
  if (!gen || gen.source?.kind !== "image") return null;
  const sig = gen.source.workflow_sig;
  const at = versions && sig ? versions.indexOf(sig) : -1;
  return (
    <Tooltip
      content={
        <div className="space-y-1.5">
          <p>
            Set up to run in Generate
            {at >= 0 && versions ? `, from version ${at + 1} of ${versions.length}` : ""}.
          </p>
          <Link to={`/generate?workflow=${encodeURIComponent(gen._id)}`} className="text-brand-300 hover:text-brand-200">
            Use this workflow
          </Link>
        </div>
      }
    >
      <Badge tone="brand" className="shrink-0 px-1.5 text-2xs" >
        In Generate
      </Badge>
    </Tooltip>
  );
}
