import type { BoxKey } from "../../../lib/promptBoard";

export const TONE: Record<BoxKey, string> = {
  subject: "border-sky-500/50 bg-sky-500/10 text-sky-100",
  hair: "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-100",
  eyes: "border-cyan-500/50 bg-cyan-500/10 text-cyan-100",
  expression: "border-pink-500/50 bg-pink-500/10 text-pink-100",
  body: "border-rose-500/50 bg-rose-500/10 text-rose-100",
  attire: "border-violet-500/50 bg-violet-500/10 text-violet-100",
  pose: "border-emerald-500/50 bg-emerald-500/10 text-emerald-100",
  framing: "border-teal-500/50 bg-teal-500/10 text-teal-100",
  background: "border-lime-500/50 bg-lime-500/10 text-lime-100",
  lighting: "border-amber-500/50 bg-amber-500/10 text-amber-100",
  style: "border-orange-500/50 bg-orange-500/10 text-orange-100",
  other: "border-line-strong bg-raised text-neutral-200",
  quality: "border-line bg-raised text-faint",
  library: "border-dashed border-amber-500/60 bg-amber-500/10 text-amber-100",
  unknown: "border-dashed border-red-500/60 bg-red-500/10 text-red-100",
  resources: "border-brand-500/50 bg-brand-500/10 text-brand-100",
  prose: "border-line bg-transparent text-muted italic",
};
