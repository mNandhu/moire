import { useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, ChevronDown, Sparkles } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Section } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProgressBar } from "../components/ui/ProgressBar";
import {
  coveragePct,
  isActiveJob,
  isStatusBusy,
  libraryCoverageRows,
  type AiLibraryCoverage,
} from "../lib/ai";
import { libraryPageHref, useAiCoverage, useLibraries } from "../lib/queries";
import { AiControllerProvider, useAiController } from "../hooks/useAiController";
import { ModelStatusLine } from "../components/ai/ModelStatus";
import { ActiveJob, RecentJobs, ResetAiTags } from "../components/ai/AiJobs";

/** A thin AI-coverage bar shared by the global stat and per-library rows. */
function CoverageBar({ tagged, total }: { tagged: number; total: number }) {
  return <ProgressBar value={coveragePct(tagged, total)} />;
}

/**
 * Coverage and the action that changes it, in one place: how much is
 * AI-tagged, the button to tag the rest, the running job, and only when it
 * matters, the model. Counts come from `/api/v1/ai/coverage` (the
 * `has_ai_tags` flag) and poll faster while a job runs.
 */
function TaggingPanel() {
  const { status, running, untaggedLimit, setUntaggedLimit, latestJob, runUntagged } =
    useAiController();
  const busy = isStatusBusy(status);
  const { data: cov } = useAiCoverage({ busy });
  const { data: libs } = useLibraries();
  const nameOf = (id: string) => {
    const l = libs?.find((x) => x._id === id);
    return l ? l.name || l.path : id;
  };

  const activeJob = latestJob && isActiveJob(latestJob.status) ? latestJob : null;
  const remaining = cov?.untagged ?? 0;
  const batch = Math.min(remaining, untaggedLimit || 0);

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
              <div className="text-sm text-muted tabular-nums">
                {coveragePct(cov.ai_tagged, cov.total)}% AI-tagged
              </div>
            </div>
            <CoverageBar tagged={cov.ai_tagged} total={cov.total} />
          </div>

          <div className="pt-4 border-t border-line space-y-4">
            {activeJob ? (
              <ActiveJob job={activeJob} />
            ) : remaining === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 size={16} className="text-brand-300" />
                Every image has AI tags.
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" onClick={() => void runUntagged()} disabled={running || !(batch > 0)}>
                  <Sparkles size={16} />
                  Tag {batch.toLocaleString()} {batch === 1 ? "image" : "images"}
                </Button>
                <label className="flex items-center gap-2 text-xs text-muted">
                  At most
                  <Input
                    type="number"
                    className="w-20 h-8"
                    value={untaggedLimit}
                    onChange={(e) => setUntaggedLimit(Number(e.target.value))}
                    min={1}
                    max={5000}
                    aria-label="Most images to tag in one run"
                  />
                  per run
                </label>
                <span className="text-xs text-faint ml-auto tabular-nums">
                  {remaining.toLocaleString()} without AI tags
                </span>
              </div>
            )}
            <ModelStatusLine />
          </div>

          {cov.per_library.length > 1 && (
            <LibraryCoverage perLibrary={cov.per_library} nameOf={nameOf} />
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
}: {
  perLibrary: AiLibraryCoverage[];
  nameOf: (id: string) => string;
}) {
  const { running, untaggedLimit, runUntagged } = useAiController();
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
              className="grid grid-cols-[minmax(0,1fr)_auto_4rem_auto] items-center gap-3 py-1.5"
            >
              <Link
                to={libraryPageHref(l.library_id)}
                className="truncate text-sm text-neutral-300 hover:text-white"
                title={l.name}
              >
                {l.name}
              </Link>
              <span
                className="text-xs text-faint tabular-nums"
                title={`${l.ai_tagged.toLocaleString()} of ${l.total.toLocaleString()} AI-tagged`}
              >
                {l.untagged.toLocaleString()} left
              </span>
              <ProgressBar value={l.pct} className="h-1" aria-label={`${l.name}: ${l.pct}% AI-tagged`} />
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => void runUntagged(l.library_id)}
                disabled={running || !(untaggedLimit > 0)}
                title={`Tag up to ${Math.min(l.untagged, untaggedLimit || 0).toLocaleString()} images in ${l.name}`}
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
