import { Link } from "react-router-dom";
import { ChevronRight, HeartPulse, Loader2, ShieldOff, Sparkles, Tag } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAiStatus } from "@/features/ai/hooks/useAiStatus";
import { coveragePct, isActiveJob } from "@/features/ai/lib/ai";
import { useAiCoverage, useImageStats } from "@/features/images/lib/queries";
import { galleryHref } from "@/features/images/lib/imageFilter";
import type { Library } from "@/features/library/lib/libraries";
import { DiscoverSection } from "@/features/discover/components/DiscoverSection";

/** A ring filled to `pct`, the number in it. */
function Ring({ pct, spinning }: { pct: number; spinning?: boolean }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" className="stroke-white/10" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          className="stroke-emerald-400 drop-shadow-[0_0_6px_rgb(52_211_153/0.6)] transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-sm font-semibold tabular-nums text-neutral-50">
        {spinning ? <Loader2 size={18} className="animate-spin text-emerald-300" /> : `${pct}%`}
      </span>
    </div>
  );
}

function Row({ icon: Icon, label, count, to }: { icon: LucideIcon; label: string; count: number; to: string }) {
  return (
    <li>
      <Link
        to={to}
        className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-neutral-200 hover:bg-white/5"
      >
        <Icon size={16} className="shrink-0 text-faint" />
        <span className="flex-1">{label}</span>
        <span className="tabular-nums text-neutral-100">{count.toLocaleString()}</span>
        <ChevronRight size={14} className="shrink-0 text-faint" />
      </Link>
    </li>
  );
}

/**
 * The library's state in one place: how much is AI-tagged (and the way to
 * tag the rest), what waits for review, what is scanning, and the counts
 * that lead to the Libraries and Tags pages.
 */
export function LibraryHealth({
  libs,
  tagCount,
  className,
}: {
  libs: Library[] | null;
  /** Undefined while loading, null when it couldn't be. */
  tagCount: number | null | undefined;
  className?: string;
}) {
  const { data: cov } = useAiCoverage();
  const { data: stats } = useImageStats();
  const { data: ai } = useAiStatus();
  const job = ai?.jobs?.recent?.find((j) => isActiveJob(j.status));
  const pct = cov ? coveragePct(cov.ai_tagged, cov.total) : 0;
  const scanning = (libs ?? []).filter((l) => l.scanning);
  // "No tags at all" says something only when manual tags make it differ.
  const noTags = cov?.no_tags != null && cov.no_tags !== cov.untagged ? cov.no_tags : 0;

  return (
    <DiscoverSection label="Library" icon={HeartPulse} tint="emerald" className={className}>
      <div className="flex items-center gap-4">
        {cov ? <Ring pct={pct} spinning={!!job} /> : <Skeleton className="h-16 w-16 rounded-full" />}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-neutral-100">{job ? "AI tagging" : "AI-tagged"}</div>
          <div className="text-sm tabular-nums text-muted">
            {job
              ? `${(job.done + job.failed).toLocaleString()} of ${job.total.toLocaleString()}`
              : cov
                ? cov.untagged
                  ? `${cov.untagged.toLocaleString()} to go`
                  : "Every image"
                : " "}
          </div>
        </div>
        {cov && !job && cov.untagged > 0 && (
          <ButtonLink size="sm" to="/ai-tagging">
            <Sparkles size={14} /> Tag them
          </ButtonLink>
        )}
      </div>

      {(noTags > 0 || !!stats?.quarantined || scanning.length > 0) && (
        <ul className="-mx-2 mt-4 border-t border-white/5 pt-2">
          {noTags > 0 && <Row icon={Tag} label="No tags at all" count={noTags} to={galleryHref({ noTags: true })} />}
          {!!stats?.quarantined && (
            <Row icon={ShieldOff} label="Quarantined" count={stats.quarantined} to={galleryHref({ quarantined: true })} />
          )}
          {scanning.length > 0 && (
            <li>
              <Link to="/libraries" className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-brand-200 hover:bg-white/5">
                <Loader2 size={16} className="shrink-0 animate-spin" />
                <span className="flex-1 truncate">
                  Scanning {scanning.length === 1 ? (scanning[0].name || scanning[0].path) : `${scanning.length} libraries`}
                </span>
                <ChevronRight size={14} className="shrink-0 text-faint" />
              </Link>
            </li>
          )}
        </ul>
      )}

      <div className="mt-4 flex gap-4 border-t border-white/5 pt-3 text-sm text-muted">
        <Link to="/libraries" className="hover:text-neutral-100">
          <span className="font-semibold tabular-nums text-neutral-100">{libs ? libs.length.toLocaleString() : "…"}</span>{" "}
          {libs?.length === 1 ? "library" : "libraries"}
        </Link>
        {tagCount !== null && (
          <Link to="/tags" className="hover:text-neutral-100">
            <span className="font-semibold tabular-nums text-neutral-100">{tagCount?.toLocaleString() ?? "…"}</span>{" "}
            {tagCount === 1 ? "tag" : "tags"}
          </Link>
        )}
      </div>
    </DiscoverSection>
  );
}
