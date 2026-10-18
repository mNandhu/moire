import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Images,
  Tags as TagsIcon,
  FolderOpen,
  Sparkles,
  Plus,
  Loader2,
} from "lucide-react";
import { StatCard } from "../components/ui/StatCard";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { useAiStatus } from "../hooks/useAiStatus";
import { isActiveJob } from "../lib/ai";
import { useAiCoverage, useLibraries, useTagAggregate } from "../lib/queries";
import { isManual } from "../lib/tags";

export default function OverviewPage() {
  const libsQuery = useLibraries();
  const tagsQuery = useTagAggregate();
  // null = still loading; a failed load reads as empty, as before.
  const libs = useMemo(
    () => libsQuery.data ?? (libsQuery.isError ? [] : null),
    [libsQuery.data, libsQuery.isError],
  );
  const tags = useMemo(
    () => tagsQuery.data ?? (tagsQuery.isError ? [] : null),
    [tagsQuery.data, tagsQuery.isError],
  );
  const { data: ai } = useAiStatus();

  const totalImages = useMemo(
    () => (libs ? libs.reduce((n, l) => n + (l.indexed_count || 0), 0) : undefined),
    [libs],
  );
  const manualCount = useMemo(
    () => (tags ? tags.filter((t) => isManual(t._id)).length : 0),
    [tags],
  );
  const scanning = useMemo(() => (libs || []).filter((l) => l.scanning), [libs]);
  const latestJob = ai?.jobs?.recent?.[0];
  // Progress, not plumbing: whether the model happens to be resident is an
  // implementation detail (it loads on demand); how much is tagged is not.
  const { data: cov } = useAiCoverage();
  const aiPct = cov && cov.total ? Math.round((cov.ai_tagged / cov.total) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <ButtonLink variant="primary" to="/libraries">
            <Plus size={16} /> Add library
          </ButtonLink>
        }
      />
      <PageBody>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard
          icon={Images}
          label="Images indexed"
          loading={totalImages === undefined}
          value={totalImages?.toLocaleString()}
          to="/"
        />
        <StatCard
          icon={TagsIcon}
          // Prompt tags are excluded from this aggregate (they're long-tail
          // and live on the Tags page behind a toggle); say so, or an image
          // full of prompt tags sits beside a "0 Tags" card.
          label="AI & manual tags"
          loading={tags === null}
          value={tags?.length.toLocaleString()}
          hint={manualCount ? `${manualCount} manual` : undefined}
          to="/tags"
        />
        <StatCard
          icon={FolderOpen}
          label="Libraries"
          loading={libs === null}
          value={libs?.length.toLocaleString()}
          hint={scanning.length ? `${scanning.length} scanning` : undefined}
          to="/libraries"
        />
        <StatCard
          icon={Sparkles}
          label="AI-tagged"
          loading={!cov}
          value={`${aiPct}%`}
          hint={cov?.untagged ? `${cov.untagged.toLocaleString()} to go` : undefined}
          to="/ai-tagging"
        />
      </div>

      {/* Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} className="text-faint" />
            <h3 className="font-semibold text-neutral-100">AI tagging</h3>
          </div>
          {latestJob ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-300">Latest job</span>
                <Badge
                  tone={
                    isActiveJob(latestJob.status)
                      ? "brand"
                      : latestJob.status === "error"
                        ? "danger"
                        : "success"
                  }
                >
                  {latestJob.status}
                </Badge>
              </div>
              <progress
                className="w-full h-1.5 [&::-webkit-progress-bar]:bg-raised [&::-webkit-progress-value]:bg-brand-500 [&::-moz-progress-bar]:bg-brand-500 rounded"
                value={latestJob.done + latestJob.failed}
                max={Math.max(1, latestJob.total)}
              />
              <div className="text-xs text-neutral-400 tabular-nums">
                {latestJob.done + latestJob.failed} / {latestJob.total} processed
              </div>
            </div>
          ) : (
            <p className="text-sm text-faint">
              No AI jobs yet. Head to{" "}
              <Link className="text-brand-300 hover:underline" to="/ai-tagging">
                AI Tagging
              </Link>{" "}
              to tag your images.
            </p>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <FolderOpen size={16} className="text-faint" />
            <h3 className="font-semibold text-neutral-100">Libraries</h3>
          </div>
          {libs === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : libs.length === 0 ? (
            <p className="text-sm text-faint">
              No libraries yet.{" "}
              <Link className="text-brand-300 hover:underline" to="/libraries">
                Add one
              </Link>{" "}
              to start indexing.
            </p>
          ) : (
            <ul className="space-y-2">
              {libs.slice(0, 4).map((l) => (
                <li
                  key={l._id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate text-neutral-200">
                    {l.name || l.path}
                  </span>
                  {l.scanning ? (
                    <span className="inline-flex items-center gap-1 text-xs text-brand-300 shrink-0">
                      <Loader2 size={12} className="animate-spin" /> scanning
                    </span>
                  ) : (
                    <span className="text-xs text-faint tabular-nums shrink-0">
                      {(l.indexed_count || 0).toLocaleString()} images
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      </PageBody>
    </>
  );
}
