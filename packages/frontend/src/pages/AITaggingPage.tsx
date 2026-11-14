import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, Sparkles } from "lucide-react";
import { PageHeader, PageBody } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Switch } from "@/components/ui/Switch";
import { Tooltip } from "@/components/ui/Tooltip";
import {
  aboutDuration,
  coveragePct,
  isActiveJob,
  isStatusBusy,
  libraryCoverageRows,
  taggingSeconds,
  type AiEstimate,
  type AiLibraryCoverage,
} from "@/features/ai/lib/ai";
import { libraryPageHref, useLibraries } from "@/features/library/lib/libraries";
import { useAiCoverage } from "@/features/images/lib/queries";
import { AiControllerProvider, useAiController } from "@/features/ai/hooks/useAiController";
import { ModelStatusLine } from "@/features/ai/components/ModelStatus";
import { ActiveJob, RecentJobs, ResetAiTags } from "@/features/ai/components/AiJobs";

/** A thin AI-coverage bar shared by the global stat and per-library rows. */
function CoverageBar({ tagged, total }: { tagged: number; total: number }) {
  return <ProgressBar value={coveragePct(tagged, total)} />;
}

const DEVICE = { cpu: "CPU", gpu: "GPU" } as const;

/** "about 22 min", with how it was worked out when this computer hasn't
 * measured a run yet. */
function Estimate({ images, est, device = false }: { images: number; est: AiEstimate | undefined; device?: boolean }) {
  const secs = taggingSeconds(images, est);
  if (secs == null || !est) return null;
  const text = `${aboutDuration(secs)}${device ? ` on the ${DEVICE[est.device]}` : ""}`;
  if (est.measured) return <span>{text}</span>;
  return (
    <Tooltip content={`From a typical ${DEVICE[est.device]} speed. Your first long run measures this computer.`}>
      <span className="cursor-help underline decoration-line-strong decoration-dotted underline-offset-[3px]">{text}</span>
    </Tooltip>
  );
}

/** Digits only, so a pasted "1,000" reads as 1000; empty is null. */
function parseCount(text: string): number | null {
  const digits = text.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/**
 * Start a run over the images without AI tags, newest first: "Tag [2,511] of
 * 2,511 images". The box starts at the whole backlog and follows it until
 * edited; its estimate follows the box.
 */
function RunControl({ remaining, est }: { remaining: number; est: AiEstimate | undefined }) {
  const { running, runUntagged } = useAiController();
  const [typed, setTyped] = useState<string | null>(null);
  const asked = typed == null ? remaining : parseCount(typed);
  const count = asked == null ? 0 : Math.min(asked, remaining);
  // The whole backlog goes without a limit, so images that arrive meanwhile join it.
  const limit = count >= remaining ? null : count;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button variant="primary" onClick={() => void runUntagged(undefined, limit)} disabled={running || count < 1}>
        <Sparkles size={16} />
        Tag
      </Button>
      <label className="flex items-center gap-2 text-sm text-muted tabular-nums">
        <Input
          inputMode="numeric"
          className="h-8 w-24 text-right tabular-nums"
          value={typed ?? remaining.toLocaleString()}
          onChange={(e) => setTyped(e.target.value.replace(/[^\d,]/g, ""))}
          onFocus={(e) => e.target.select()}
          onBlur={() => typed != null && setTyped(count >= remaining ? null : count.toLocaleString())}
          aria-label="Images to tag"
        />
        of {remaining.toLocaleString()} {remaining === 1 ? "image" : "images"}
      </label>
      {count > 0 && (
        <span className="text-sm text-faint tabular-nums">
          <Estimate images={count} est={est} device />
        </span>
      )}
    </div>
  );
}

/** Tag new images as they arrive, and whatever is left when switched on. */
function AutoTagSwitch() {
  const { autoTag, setAutoTag, running } = useAiController();
  return (
    <label className="ml-auto flex items-center gap-2 text-sm text-muted">
      <Switch on={autoTag} onChange={(on) => !running && void setAutoTag(on)} aria-label="Auto-tag new images" />
      Auto-tag new images
    </label>
  );
}

/**
 * Coverage and the action that changes it, in one place: how much is
 * AI-tagged, the run that tags the rest and how long it takes, the running
 * job, and only when it matters, the model. Counts come from
 * `/api/v1/ai/coverage` (the `has_ai_tags` flag) and poll faster while a
 * job runs.
 */
function TaggingPanel() {
  const { status, latestJob } = useAiController();
  const busy = isStatusBusy(status);
  const { data: cov } = useAiCoverage({ busy });
  const { data: libs } = useLibraries();
  const nameOf = (id: string) => {
    const l = libs?.find((x) => x._id === id);
    return l ? l.name || l.path : id;
  };

  const activeJob = latestJob && isActiveJob(latestJob.status) ? latestJob : null;
  const remaining = cov?.untagged ?? 0;
  const est = status?.estimate;

  return (
    <Section title="Coverage">
      {cov ? (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-end justify-between gap-3">
              <div className="text-3xl font-semibold tabular-nums text-neutral-100">
                {cov.ai_tagged.toLocaleString()}
                <span className="text-lg font-medium text-faint">
                  {" "}
                  / {cov.total.toLocaleString()}
                </span>
              </div>
              <div className="text-right text-sm text-muted tabular-nums">
                <div>{coveragePct(cov.ai_tagged, cov.total)}% AI-tagged</div>
                {remaining > 0 && (
                  <div className="text-xs text-faint">
                    {remaining.toLocaleString()} left
                    {taggingSeconds(remaining, est) != null && (
                      <>
                        {" · "}
                        <Estimate images={remaining} est={est} />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
            <CoverageBar tagged={cov.ai_tagged} total={cov.total} />
          </div>

          <div className="pt-4 border-t border-line space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {activeJob ? (
                <div className="min-w-0 flex-1 basis-80">
                  <ActiveJob job={activeJob} />
                </div>
              ) : remaining === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <CheckCircle2 size={16} className="text-brand-300" />
                  Every image has AI tags.
                </div>
              ) : (
                <RunControl remaining={remaining} est={est} />
              )}
              <AutoTagSwitch />
            </div>
            <ModelStatusLine />
          </div>

          {cov.per_library.length > 1 && (
            <LibraryCoverage perLibrary={cov.per_library} nameOf={nameOf} est={est} />
          )}
        </div>
      ) : (
        <div className="text-sm text-faint">Loading coverage…</div>
      )}
    </Section>
  );
}

const SHOWN = 8;

/**
 * Coverage per library, as a list rather than a bar each: the libraries with
 * images left to tag, most first, each with its own run; the finished ones
 * folded into one line.
 */
function LibraryCoverage({
  perLibrary,
  nameOf,
  est,
}: {
  perLibrary: AiLibraryCoverage[];
  nameOf: (id: string) => string;
  est: AiEstimate | undefined;
}) {
  const { running, runUntagged, latestJob } = useAiController();
  // A job running now holds the untagged images: another run would get none.
  const busy = running || (latestJob != null && isActiveJob(latestJob.status));
  const [all, setAll] = useState(false);
  const { todo, done } = libraryCoverageRows(perLibrary, nameOf);
  const shown = all ? todo : todo.slice(0, SHOWN);

  return (
    <div className="pt-4 border-t border-line space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-medium text-neutral-200">Libraries</h4>
        {todo.length > 0 && (
          <span className="text-xs text-faint tabular-nums">
            {todo.length} of {perLibrary.length} not done
          </span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="divide-y divide-line/60">
          {shown.map((l) => (
            <li
              key={l.library_id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto_4rem_auto] items-center gap-3 py-1.5"
            >
              <Link
                to={libraryPageHref(l.library_id)}
                className="truncate text-sm text-neutral-300 hover:text-white"
              >
                {l.name}
              </Link>
              <span className="text-xs text-faint tabular-nums">{l.untagged.toLocaleString()} left</span>
              <span className="text-right text-xs text-faint tabular-nums">
                <Estimate images={l.untagged} est={est} />
              </span>
              <ProgressBar value={l.pct} className="h-1" aria-label={`${l.name}: ${l.pct}% AI-tagged`} />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => void runUntagged(l.library_id)}
                disabled={busy}
                aria-label={`Tag ${l.name}`}
              >
                <Sparkles size={12} /> Tag
              </Button>
            </li>
          ))}
        </ul>
      )}
      {todo.length > SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-xs text-brand-300 hover:text-brand-200"
        >
          {all ? "Show fewer" : `Show all ${todo.length}`}
        </button>
      )}
      {done.length > 0 && (
        <details className="group text-xs text-faint">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-neutral-200">
            <CheckCircle2 size={14} className="text-brand-300" />
            {done.length === 1 ? "1 library" : `${done.length} libraries`} fully tagged
            <ChevronDown size={12} className="transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-1.5 leading-relaxed">{done.map((l) => l.name).join(", ")}</p>
        </details>
      )}
    </div>
  );
}

export default function AITaggingPage() {
  return (
    <AiControllerProvider>
      <PageHeader
        title="AI Tagging"
        description="Tag images with a local WD tagger model."
      />
      <PageBody className="space-y-5">
        <TaggingPanel />
        <RecentJobs />
        <ResetAiTags />
      </PageBody>
    </AiControllerProvider>
  );
}
