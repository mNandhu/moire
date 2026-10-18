import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Input, Field } from "../../../components/ui/Input";
import { isActiveJob, type AiJobError } from "../../../lib/ai";
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
      <div className="mt-1 max-h-40 overflow-auto space-y-1 rounded border border-red-900/50 bg-red-950/20 p-2">
        {errors.map((e, i) => (
          <div key={`${e.image_id}:${i}`} className="text-neutral-300">
            <span className="font-mono text-neutral-400">{e.image_id}</span>
            <span className="text-faint"> — </span>
            <span className="text-red-300">{e.error}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

export function JobsSection() {
  const {
    status,
    running,
    untaggedLimit,
    setUntaggedLimit,
    latestJob,
    progressPct,
    runUntagged,
    clearAllAiTags,
    cancelJob,
  } = useSettings();

  return (
    <div className="space-y-6">
      <Card className="p-5 space-y-3">
        <div className="font-semibold">Run AI Tagging</div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Untagged-by-AI limit" htmlFor="ai_untagged_limit">
            <Input
              id="ai_untagged_limit"
              type="number"
              className="w-40"
              value={untaggedLimit}
              onChange={(e) => setUntaggedLimit(Number(e.target.value))}
              min={1}
              max={5000}
            />
          </Field>
          <Button variant="success" onClick={runUntagged} disabled={running}>
            Tag un-AI-tagged images
          </Button>
        </div>

        <div className="pt-2 border-t border-neutral-800 flex flex-wrap items-center gap-2">
          <Button
            variant="dangerSoft"
            onClick={clearAllAiTags}
            disabled={running}
            title="Removes AI tags and AI metadata from every image. Keeps manual: tags."
          >
            Clear ALL AI tags (all libraries)
          </Button>
          <div className="text-xs text-faint">
            Use this if you want to re-run AI tagging from scratch.
          </div>
        </div>

        {latestJob && (
          <div className="space-y-2">
            <div className="text-sm text-neutral-300">
              Latest job:{" "}
              <span
                className="font-mono"
                title="Job ID: used to track progress (polling), debug issues, and cancel jobs"
              >
                {latestJob.id.slice(0, 8)}
              </span>{" "}
              · {latestJob.status} · {latestJob.done + latestJob.failed}/
              {latestJob.total}
              {typeof latestJob.skipped === "number" && latestJob.skipped > 0 ? (
                <span className="text-faint">
                  {" "}
                  · {latestJob.skipped} skipped
                </span>
              ) : null}
            </div>
            <progress
              className="w-full h-2 [&::-webkit-progress-bar]:bg-neutral-800 [&::-webkit-progress-value]:bg-brand-600 [&::-moz-progress-bar]:bg-brand-600"
              value={progressPct}
              max={100}
            />
            {latestJob.current && (
              <div className="text-xs text-faint truncate">
                Current: {latestJob.current}
              </div>
            )}

            {isActiveJob(latestJob.status) && (
              <div>
                <Button
                  variant="danger"
                  onClick={() => cancelJob(latestJob.id)}
                  disabled={running}
                >
                  Cancel latest job
                </Button>
              </div>
            )}

            {latestJob.errors && latestJob.errors.length > 0 && (
              <JobErrors errors={latestJob.errors} />
            )}
          </div>
        )}
      </Card>

      <Card className="p-5 space-y-2">
        <div className="font-semibold">Recent jobs</div>
        <div className="space-y-2">
          {(status?.jobs?.recent || []).map((j) => (
            <div
              key={j.id}
              className="rounded border border-neutral-800 bg-neutral-950/40 px-3 py-2 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span
                    className="font-mono"
                    title="Job ID: used to track progress (polling), debug issues, and cancel jobs"
                  >
                    {j.id.slice(0, 8)}
                  </span>
                  <span className="text-faint"> · {j.status}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-xs text-neutral-400">
                    {j.done + j.failed}/{j.total}
                    {typeof j.skipped === "number" && j.skipped > 0 ? (
                      <span className="text-faint">
                        {" "}
                        · {j.skipped} skipped
                      </span>
                    ) : null}
                    {j.failed ? (
                      <span className="text-red-300"> · {j.failed} failed</span>
                    ) : null}
                  </div>
                  {isActiveJob(j.status) && (
                    <Button
                      size="sm"
                      variant="dangerSoft"
                      onClick={() => cancelJob(j.id)}
                      disabled={running}
                      title="Cancel job"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
              {j.errors && j.errors.length > 0 && (
                <JobErrors errors={j.errors} />
              )}
            </div>
          ))}
          {!status?.jobs?.recent?.length && (
            <div className="text-sm text-faint">No jobs yet.</div>
          )}
        </div>
      </Card>
    </div>
  );
}
