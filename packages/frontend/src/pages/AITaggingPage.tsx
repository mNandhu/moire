import { CheckCircle2, Sparkles } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { Section } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ProgressBar } from "../components/ui/ProgressBar";
import { coveragePct, isActiveJob, isStatusBusy } from "../lib/ai";
import { useAiCoverage, useLibraries } from "../lib/queries";
import { SettingsProvider, useSettings } from "./settings/SettingsContext";
import { ModelStatusLine } from "./settings/sections/ModelSection";
import { ActiveJob, RecentJobs, ResetAiTags } from "./settings/sections/JobsSection";

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
    useSettings();
  const busy = isStatusBusy(status);
  const { data: cov } = useAiCoverage({ busy });
  const { data: libs } = useLibraries();
  const nameOf = (id: string) => libs?.find((l) => l._id === id)?.name || id;

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

          {cov.per_library.length > 1 && (
            <div className="space-y-3">
              {cov.per_library.map((l) => (
                <div key={l.library_id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate text-neutral-300">{nameOf(l.library_id)}</span>
                    <span className="text-faint tabular-nums">
                      {l.ai_tagged.toLocaleString()} / {l.total.toLocaleString()}
                    </span>
                  </div>
                  <CoverageBar tagged={l.ai_tagged} total={l.total} />
                </div>
              ))}
            </div>
          )}

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
                <Button variant="primary" onClick={runUntagged} disabled={running || !batch}>
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
        </div>
      ) : (
        <div className="text-sm text-faint">Loading coverage…</div>
      )}
    </Section>
  );
}

export default function AITaggingPage() {
  return (
    <SettingsProvider>
      <PageHeader
        title="AI Tagging"
        description="Tag images with a local WD tagger model."
      />
      <PageBody className="space-y-5">
        <TaggingPanel />
        <RecentJobs />
        <ResetAiTags />
      </PageBody>
    </SettingsProvider>
  );
}
