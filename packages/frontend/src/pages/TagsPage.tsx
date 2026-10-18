import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Tag as TagIcon, Slash, Search } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { Skeleton } from "../components/ui/Skeleton";
import { Button, ButtonLink } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { cn } from "../lib/cn";
import { api } from "../lib/api";
import { useAiCoverage, useTagAggregate, type TagAgg } from "../lib/queries";
import { formatTag, isManual, isPrompt } from "../lib/tags";

type Sample = { _id: string; thumb_url: string };

const PAGE = 60;

export default function TagsPage() {
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(PAGE);
  const [samples, setSamples] = useState<Record<string, Sample[]>>({});
  // Prompt-extracted tags are large and long-tail, so they stay off by default;
  // this opts the whole browser into showing them alongside AI + manual tags.
  const [includePrompt, setIncludePrompt] = useState(false);
  const requested = useRef<Set<string>>(new Set());

  const tagsQuery = useTagAggregate({ includePrompt });
  // null = still loading; a failed load reads as empty, as before.
  const tags: TagAgg[] | null = useMemo(
    () => tagsQuery.data ?? (tagsQuery.isError ? [] : null),
    [tagsQuery.data, tagsQuery.isError],
  );

  const { data: cov } = useAiCoverage();

  // Reset paging when the search term changes.
  useEffect(() => setVisible(PAGE), [q]);

  const filtered = useMemo(() => {
    if (!tags) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return tags;
    return tags.filter((t) => formatTag(t._id).toLowerCase().includes(needle));
  }, [tags, q]);

  const shown = useMemo(() => filtered.slice(0, visible), [filtered, visible]);

  // Fetch mosaic samples for the currently-visible tags we haven't asked for yet.
  useEffect(() => {
    const need = shown
      .map((t) => t._id)
      .filter((id) => !requested.current.has(id));
    if (!need.length) return;
    need.forEach((id) => requested.current.add(id));
    const params = new URLSearchParams();
    need.forEach((id) => params.append("tags", id));
    params.set("per", "4");
    api<Record<string, Sample[]>>(`/api/v1/tags/samples?${params}`)
      .then((data) => setSamples((prev) => ({ ...prev, ...data })))
      .catch(() => {
        // Allow a retry on next render if the batch failed.
        need.forEach((id) => requested.current.delete(id));
      });
  }, [shown]);

  return (
    <>
      <PageHeader title="Tags" count={tags?.length} width="wide" />
      <PageBody width="wide">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative max-w-md flex-1">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              className="pl-9"
              placeholder="Filter tags…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button
            active={includePrompt}
            onClick={() => setIncludePrompt((v) => !v)}
            title="Show tags extracted from generation prompts"
          >
            {includePrompt ? "Hide prompt tags" : "Show prompt tags"}
          </Button>
        </div>

      {/* Shortcuts to what still needs work */}
      <div className="flex flex-wrap gap-3 mb-6">
        <SpecialTile
          title="Untagged"
          subtitle={
            cov?.no_tags != null
              ? `${cov.no_tags.toLocaleString()} ${cov.no_tags === 1 ? "image" : "images"} with no tags`
              : "No tags at all"
          }
          to="/?no_tags=1"
        />
        <SpecialTile
          title="Missing AI tags"
          subtitle={
            cov
              ? `${cov.untagged.toLocaleString()} ${cov.untagged === 1 ? "image" : "images"} not AI-tagged`
              : "Not yet AI-tagged"
          }
          to="/?no_ai_tags=1"
        />
      </div>

      {tags !== null && filtered.length === 0 && (
        q.trim() ? (
          <EmptyState
            compact
            icon={Search}
            title={`No tags match “${q.trim()}”`}
            description={includePrompt ? undefined : "Prompt tags are hidden. Try showing them."}
          />
        ) : (
          <EmptyState
            compact
            icon={TagIcon}
            title="No tags yet"
            description="Run AI tagging, or add tags to images from their detail view."
            actions={
              <ButtonLink variant="primary" to="/ai-tagging">
                Go to AI Tagging
              </ButtonLink>
            }
          />
        )
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3">
        {tags === null
          ? Array.from({ length: 12 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl overflow-hidden border border-white/5 bg-surface shadow-panel"
              >
                <Skeleton className="w-full aspect-square rounded-none" />
                <div className="p-3 space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-14" />
                </div>
              </div>
            ))
          : shown.map((t) => (
              <TagCard
                key={t._id}
                tag={t}
                samples={samples[t._id]}
                to={`/?tags=${encodeURIComponent(t._id)}`}
              />
            ))}
      </div>

      {filtered.length > visible && (
        <div className="flex justify-center mt-6">
          <Button onClick={() => setVisible((v) => v + PAGE)}>
            Show more ({(filtered.length - visible).toLocaleString()} left)
          </Button>
        </div>
      )}
      </PageBody>
    </>
  );
}

function SpecialTile({
  title,
  subtitle,
  to,
}: {
  title: string;
  subtitle: string;
  to: string;
}) {
  return (
    <Link
      to={to}
      title={title}
      className="rounded-xl border border-white/5 bg-surface bg-sheen shadow-panel px-4 py-3 text-left card-hover min-w-[180px]"
    >
      <div className="flex items-center gap-2 font-semibold">
        <span className="relative inline-flex items-center justify-center w-5 h-5">
          <TagIcon size={16} />
          <Slash size={16} className="absolute inset-0 text-brand-300" />
        </span>
        {title}
      </div>
      <div className="text-xs text-muted mt-0.5">{subtitle}</div>
    </Link>
  );
}

function TagCard({
  tag,
  samples,
  to,
}: {
  tag: TagAgg;
  samples: Sample[] | undefined;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-xl overflow-hidden border border-white/5 bg-surface bg-sheen shadow-panel text-left card-hover"
    >
      <Mosaic samples={samples} />
      <div className="p-3">
        <div className="text-sm font-semibold flex items-center gap-2">
          <span className="truncate">{formatTag(tag._id)}</span>
          {isManual(tag._id) && (
            <Badge className="text-2xs shrink-0">
              manual
            </Badge>
          )}
          {isPrompt(tag._id) && (
            <Badge className="text-2xs shrink-0">
              prompt
            </Badge>
          )}
        </div>
        <div className="text-xs text-neutral-400 tabular-nums">
          {tag.count.toLocaleString()} images
        </div>
      </div>
    </Link>
  );
}

/** 2x2 collage of distinct images. Adapts to 1–4 samples; cells crop to
 * keep a tidy square (it reads as a deliberate collage, not a thumbnail). */
function Mosaic({ samples }: { samples: Sample[] | undefined }) {
  if (samples === undefined) {
    return <Skeleton className="w-full aspect-square rounded-none" />;
  }
  if (samples.length === 0) {
    return (
      <div className="w-full aspect-square bg-raised flex items-center justify-center text-faint">
        <TagIcon size={28} />
      </div>
    );
  }

  const cells = samples.slice(0, 4);
  // Layout per count: 1 = full, 2 = halves, 3 = big + 2, 4 = 2x2.
  const spanClass = (i: number) => {
    if (cells.length === 1) return "col-span-2 row-span-2";
    if (cells.length === 2) return "row-span-2";
    if (cells.length === 3 && i === 0) return "row-span-2";
    return "";
  };

  return (
    <div className="grid grid-cols-2 grid-rows-2 gap-px aspect-square bg-raised">
      {cells.map((s, i) => (
        <div
          key={s._id}
          className={cn("relative overflow-hidden bg-neutral-900", spanClass(i))}
        >
          <img
            src={s.thumb_url}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
        </div>
      ))}
    </div>
  );
}
