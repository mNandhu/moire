import { Section } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge } from "../../../components/ui/Badge";
import { ProgressBar } from "../../../components/ui/ProgressBar";
import {
  isActiveJob,
  jobAgo,
  jobStatusLabel,
  type AiJob,
  type AiJobError,
} from "../../../lib/ai";
import { useSettings } from "../SettingsContext";

/** Expandable per-job failure list. The backend records one entry per image
 * that threw during tagging ({@link AiJobError}); the status poll already
 * carries these, so this is purely a disclosure over data we have. */
function JobErrors({ errors }: { errors: AiJobError[] }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-red-300 hover:text-red-200">
        {errors.length} {errors.length === 1 ? "error" : "errors"}
      </summary>
      <div className="mt-1 max-h-40 overflow-auto space-y-1 rounded-lg border border-line bg-canvas p-2">
        {errors.map((e, i) => (
          <div key={`${e.image_id}:${i}`} className="text-neutral-300">
            <span className="font-mono text-muted">{e.image_id}</span>
            <span className="text-faint"> — </span>
            <span className="text-red-300">{e.error}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function statusTone(status: string) {
  if (isActiveJob(status)) return "brand" as const;
  if (status === "error") return "danger" as const;
  return "neutral" as const;
}

/** Progress of the job that's running now, with its cancel control. */
export function ActiveJob({ job }: { job: AiJob }) {
  const { running, progressPct, cancelJob } = useSettings();
  const processed = job.done + job.failed;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-neutral-200 tabular-nums">
          {jobStatusLabel(job.status)} · {processed.toLocaleString()} of{" "}
          {job.total.toLocaleString()}
          {job.failed > 0 && <span className="text-red-300"> · {job.failed} failed</span>}
        </span>
        <Button
          size="sm"
          onClick={() => cancelJob(job.id)}
          disabled={running || job.status === "cancelling"}
        >
          Cancel
        </Button>
      </div>
      <ProgressBar value={progressPct} aria-label="Tagging progress" />
      {job.current && (
        <div className="text-xs text-faint truncate" title={job.current}>
          {job.current}
        </div>
      )}
    </div>
  );
}

export function RecentJobs() {
  const { status } = useSettings();
  const jobs = status?.jobs?.recent || [];

  return (
    <Section title="Recent jobs">
      {jobs.length === 0 ? (
        <p className="text-sm text-faint">
          Nothing yet — jobs you run show up here.
        </p>
      ) : (
        <ul className="divide-y divide-line -my-2">
          {jobs.map((j) => (
            <li key={j.id} className="py-2.5 space-y-1.5" title={`Job ${j.id}`}>
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
                  <span className="text-neutral-200 tabular-nums">
                    {j.total.toLocaleString()} {j.total === 1 ? "image" : "images"}
                  </span>
                  {(j.skipped ?? 0) > 0 && (
                    <span className="text-faint text-xs">{j.skipped} skipped</span>
                  )}
                  {j.failed > 0 && (
                    <span className="text-red-300 text-xs">{j.failed} failed</span>
                  )}
                </div>
                <span className="text-xs text-faint shrink-0">{jobAgo(j.created_at)}</span>
              </div>
              {j.errors && j.errors.length > 0 && <JobErrors errors={j.errors} />}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** The one destructive action on the page, set apart from the run controls. */
export function ResetAiTags() {
  const { running, clearAllAiTags } = useSettings();
  return (
    <Section
      title="Start over"
      description="Remove AI tags from every image in every library, so the next run tags them from scratch. Manual tags are kept."
      actions={
        <Button variant="dangerSoft" size="sm" onClick={clearAllAiTags} disabled={running}>
          Clear AI tags…
        </Button>
      }
    />
  );
}
