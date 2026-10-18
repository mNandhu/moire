import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Images,
  Tags as TagsIcon,
  FolderOpen,
  Cpu,
  Sparkles,
  Plus,
  Loader2,
} from "lucide-react";
import { StatCard } from "../components/ui/StatCard";
import { PageHeader } from "../components/ui/PageHeader";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";
import { useAiStatus } from "../hooks/useAiStatus";
import { isActiveJob } from "../lib/ai";
import { api } from "../lib/api";
import { isManual } from "../lib/tags";

type Library = {
  _id: string;
  name?: string;
  path: string;
  indexed_count?: number;
  scanning?: boolean;
};
type TagAgg = { _id: string };

export default function OverviewPage() {
  const navigate = useNavigate();
  const [libs, setLibs] = useState<Library[] | null>(null);
  const [tags, setTags] = useState<TagAgg[] | null>(null);
  const { data: ai } = useAiStatus();

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<Library[]>("/api/v1/libraries")
        .then((d) => alive && setLibs(d))
        .catch(() => alive && setLibs([]));
      api<TagAgg[]>("/api/v1/tags?include_manual=1")
        .then((d) => alive && setTags(d))
        .catch(() => alive && setTags([]));
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

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

  const modelLoaded = Boolean(ai?.model?.loaded);
  const modelLoading = ai?.model_load?.status === "loading";
  const modelState = modelLoading
    ? "Loading…"
    : modelLoaded
      ? "Loaded"
      : "Unloaded";

  return (
    <div className="p-6">
      <PageHeader
        title="Overview"
        description="Your local image library at a glance."
        actions={
          <Button variant="primary" onClick={() => navigate("/libraries")}>
            <Plus size={16} /> Add library
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard
          icon={Images}
          label="Images indexed"
          tone="brand"
          loading={totalImages === undefined}
          value={totalImages?.toLocaleString()}
          onClick={() => navigate("/")}
        />
        <StatCard
          icon={TagsIcon}
          label="Tags"
          tone="blue"
          loading={tags === null}
          value={tags?.length.toLocaleString()}
          hint={manualCount ? `${manualCount} manual` : undefined}
          onClick={() => navigate("/tags")}
        />
        <StatCard
          icon={FolderOpen}
          label="Libraries"
          tone="emerald"
          loading={libs === null}
          value={libs?.length.toLocaleString()}
          hint={scanning.length ? `${scanning.length} scanning` : undefined}
          onClick={() => navigate("/libraries")}
        />
        <StatCard
          icon={Cpu}
          label="AI model"
          tone="neutral"
          value={modelState}
          hint={ai?.model?.repo ?? undefined}
          onClick={() => navigate("/ai-tagging")}
        />
      </div>

      {/* Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={16} className="text-brand-300" />
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
                className="w-full h-2 [&::-webkit-progress-bar]:bg-neutral-800 [&::-webkit-progress-value]:bg-brand-600 [&::-moz-progress-bar]:bg-brand-600 rounded"
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
              <button
                className="text-brand-300 hover:underline"
                onClick={() => navigate("/ai-tagging")}
              >
                AI Tagging
              </button>{" "}
              to tag your images.
            </p>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <FolderOpen size={16} className="text-emerald-300" />
            <h3 className="font-semibold text-neutral-100">Libraries</h3>
          </div>
          {libs === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : libs.length === 0 ? (
            <p className="text-sm text-faint">
              No libraries yet.{" "}
              <button
                className="text-brand-300 hover:underline"
                onClick={() => navigate("/libraries")}
              >
                Add one
              </button>{" "}
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
    </div>
  );
}
