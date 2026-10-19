import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Tag as TagIcon, Slash, Search, Pencil, GitMerge, Undo2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { Skeleton } from "../components/ui/Skeleton";
import { Button, ButtonLink } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { cn } from "../lib/cn";
import { api } from "../lib/api";
import {
  TAG_ALIASES_KEY,
  deleteTagAlias,
  renameTag,
  useAiCoverage,
  useBoilerplate,
  useTagAggregate,
  useTagAliases,
  type TagAgg,
} from "../lib/queries";
import { formatTag, isAiTag, isManual, isPrompt, tagQueryText } from "../lib/tags";
import { invalidateFeeds } from "../lib/feedCache";
import { useToast } from "../components/Toasts";
import { RenameTagDialog } from "../components/RenameTagDialog";

type Sample = { _id: string; thumb_url: string };

const PAGE = 60;

export default function TagsPage() {
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(PAGE);
  const [samples, setSamples] = useState<Record<string, Sample[]>>({});
  // Prompt-extracted tags are large and long-tail, so they stay off by default;
  // this opts the whole browser into showing them alongside AI + manual tags.
  const [includePrompt, setIncludePrompt] = useState(false);
  // Boilerplate (Settings) is hidden unless asked for: it would otherwise fill
  // the top of the grid, being on nearly every image.
  const [showBoilerplate, setShowBoilerplate] = useState(false);
  const isBoilerplate = useBoilerplate();
  const requested = useRef<Set<string>>(new Set());

  const tagsQuery = useTagAggregate({ includePrompt });
  // null = still loading; a failed load reads as empty, as before.
  const tags: TagAgg[] | null = useMemo(
    () => tagsQuery.data ?? (tagsQuery.isError ? [] : null),
    [tagsQuery.data, tagsQuery.isError],
  );

  const { data: cov } = useAiCoverage();

  // --- Rename / merge ---------------------------------------------------------
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [renaming, setRenaming] = useState<TagAgg | null>(null);
  const [showRules, setShowRules] = useState(false);
  const { data: aliases } = useTagAliases();

  // A rename moves images between tags, so every mosaic may be stale.
  const afterTagWrite = () => {
    invalidateFeeds(queryClient);
    queryClient.invalidateQueries({ queryKey: TAG_ALIASES_KEY });
    requested.current.clear();
    setSamples({});
  };

  const onRename = async (tag: string, to: string) => {
    try {
      const res = await renameTag(tag, to);
      afterTagWrite();
      push(
        `${res.kind === "prompt" ? "Merged" : "Renamed"} “${formatTag(res.from)}” into “${formatTag(res.to)}” on ${res.images.toLocaleString()} images`,
        "success",
      );
      return true;
    } catch (e) {
      push(`Rename failed: ${String(e)}`, "error");
      return false;
    }
  };

  const onUndoRule = async (from: string) => {
    try {
      const res = await deleteTagAlias(from);
      afterTagWrite();
      push(`Removed rule “${formatTag(res.from)}” → “${formatTag(res.to)}”`, "success");
    } catch (e) {
      push(`Couldn't remove the rule: ${String(e)}`, "error");
    }
  };

  // Reset paging when the search term changes.
  useEffect(() => setVisible(PAGE), [q]);

  const boilerplateCount = useMemo(
    () => (tags ? tags.filter((t) => isBoilerplate(t._id)).length : 0),
    [tags, isBoilerplate],
  );

  const filtered = useMemo(() => {
    if (!tags) return [];
    const pool = showBoilerplate ? tags : tags.filter((t) => !isBoilerplate(t._id));
    const needle = tagQueryText(q.trim());
    if (!needle) return pool;
    return pool.filter((t) => formatTag(t._id).toLowerCase().includes(needle));
  }, [tags, q, showBoilerplate, isBoilerplate]);

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
          {boilerplateCount > 0 && (
            <Button
              active={showBoilerplate}
              onClick={() => setShowBoilerplate((v) => !v)}
              title="Boilerplate tags are set in Settings"
            >
              {showBoilerplate
                ? "Hide boilerplate"
                : `Show boilerplate (${boilerplateCount.toLocaleString()})`}
            </Button>
          )}
          {!!aliases?.length && (
            <Button
              active={showRules}
              onClick={() => setShowRules((v) => !v)}
              title="Prompt tags you merged into another name"
            >
              <GitMerge size={15} /> Merge rules ({aliases.length.toLocaleString()})
            </Button>
          )}
        </div>

        {showRules && !!aliases?.length && (
          <div className="mb-6 rounded-xl border border-white/5 bg-surface shadow-panel divide-y divide-white/5">
            {aliases.map((a) => (
              <div key={a.from} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="truncate text-muted">{formatTag(a.from)}</span>
                <span className="text-faint">→</span>
                <span className="truncate font-medium">{formatTag(a.to)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto shrink-0"
                  onClick={() => void onUndoRule(a.from)}
                  title={`Stop merging “${formatTag(a.from)}”; images get their own prompt's name back`}
                >
                  <Undo2 size={14} /> Undo
                </Button>
              </div>
            ))}
          </div>
        )}

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
            description={
              !includePrompt
                ? "Prompt tags are hidden. Try showing them."
                : !showBoilerplate && boilerplateCount
                  ? "Boilerplate tags are hidden. Try showing them."
                  : undefined
            }
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
                onRename={isAiTag(t._id) ? undefined : () => setRenaming(t)}
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
      <RenameTagDialog
        tag={renaming}
        known={tags ?? []}
        onClose={() => setRenaming(null)}
        onRename={onRename}
      />
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
  onRename,
}: {
  tag: TagAgg;
  samples: Sample[] | undefined;
  to: string;
  /** Absent for AI tags, which come from the tagger's fixed vocabulary. */
  onRename?: () => void;
}) {
  return (
    <div className="group relative">
      <Link
        to={to}
        className="block rounded-xl overflow-hidden border border-white/5 bg-surface bg-sheen shadow-panel text-left card-hover"
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
      {onRename && (
        // A sibling of the card link, not inside it: a button nested in an <a>
        // is invalid and its click would also follow the link.
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename or merge ${formatTag(tag._id)}`}
          title="Rename or merge"
          className="absolute top-2 right-2 h-8 w-8 rounded-full inline-flex items-center justify-center bg-black/60 text-white/80 hover:text-white backdrop-blur-sm md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
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
