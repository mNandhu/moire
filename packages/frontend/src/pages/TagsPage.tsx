import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocalPref } from "../hooks/useLocalPref";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Tag as TagIcon, Slash, Search, GitMerge, Undo2, LayoutGrid, List, UserPlus, Wand2, Sparkles } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Skeleton } from "../components/ui/Skeleton";
import { Button, ButtonLink } from "../components/ui/Button";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { Input } from "../components/ui/Input";
import { cn } from "../lib/cn";
import { api, errorText } from "../lib/api";
import { smallThumb } from "../lib/media";
import {
  MERGE_SUGGESTIONS_KEY,
  TAG_ALIASES_KEY,
  addTagRules,
  deleteTagAlias,
  renameTag,
  useAiCoverage,
  useBoilerplate,
  useTagAggregate,
  useTagAliases,
  useTagBrowse,
  useTagDescriptions,
  useTagGroups,
  useMergeSuggestions,
  type TagAgg,
} from "../lib/queries";
import { descriptionKey, formatTag, tagName } from "../lib/tags";
import { invalidateFeeds } from "../lib/feedCache";
import { useHotkeys } from "../hooks/useHotkeys";
import {
  SORT_LABEL,
  SOURCE_LABEL,
  filterTags,
  galleryTag,
  sortTags,
  splitSections,
  type BrowseTag,
  type TagSort,
  type TagSource,
  type TagView,
} from "../lib/tagBrowse";
import { useToast } from "../components/Toasts";
import { RenameTagDialog } from "../components/RenameTagDialog";
import { MergeSuggestions } from "../components/MergeSuggestions";
import { TagPanel } from "../components/TagPanel";
import { Mosaic, type Sample } from "../components/TagMosaic";
import { FaceCrop } from "../components/CharacterAvatar";
import { useCharacterLookup, useCharacters } from "../components/ImageCharacters";
import { NewCharacterDialog } from "../components/NewCharacterDialog";
import { Tooltip } from "../components/ui/Tooltip";
import { Picker } from "../components/ui/Picker";
import { groupHref, groupLabel, groupOf, groupOptions } from "../lib/tagGroups";
import { CARD_ZOOM, characterHref, displayName, focusPosition, inkOn, type CharacterEntry } from "../lib/character";

type Describe = (tag: string) => string | undefined;

// A spine for a character with no colour of its own.
const SPINE_NEUTRAL = "#8a8797";

/** Entries per section before "Show more": grid cards load 3 or 4 images
 * each, list rows one, so the list can afford more. */
const PAGE: Record<TagView, number> = { grid: 60, list: 200 };
const VIEW_KEY = "moire.tags.view";

/** `/tags/groups/:group`: the Tags page narrowed to one tag group. */
export function TagGroupPage() {
  const { group = "" } = useParams();
  return <TagsPage key={group} group={group} />;
}

export default function TagsPage({ group }: { group?: string } = {}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [view, setView] = useLocalPref<TagView>(VIEW_KEY, "grid", {
    parse: (raw) => (raw === "list" ? "list" : "grid"),
  });
  const [sort, setSort] = useState<TagSort>("count");
  const [source, setSource] = useState<TagSource>("all");
  // Boilerplate (Settings) is hidden unless asked for: it would otherwise fill
  // the top of the list, being on nearly every image.
  const [showBoilerplate, setShowBoilerplate] = useState(false);
  // The open tag lives in the URL (`?tag=`), so other pages can link to it
  // (the image view's characters) and Back closes it.
  const [params, setParams] = useSearchParams();
  const selected = params.get("tag");
  const setSelected = useCallback(
    (tag: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (tag) next.set("tag", tag);
          else next.delete("tag");
          return next;
        },
        { replace: !!selected && !!tag },
      ),
    [setParams, selected],
  );
  const isBoilerplate = useBoilerplate();
  const { data: descriptions } = useTagDescriptions();
  const describe = useCallback<Describe>((tag) => descriptions?.[descriptionKey(tag)], [descriptions]);


  const tagsQuery = useTagBrowse(source);
  const groupsQuery = useTagGroups();
  const groups = groupsQuery.data;
  // null = still loading; a failed load reads as empty. On a group page,
  // only that group's tags (loading until the group map is in too).
  const tags: BrowseTag[] | null = useMemo(() => {
    const all = tagsQuery.data ?? (tagsQuery.isError ? [] : null);
    if (!group || !all) return all;
    if (!groups) return groupsQuery.isError ? [] : null;
    return all.filter((t) => groupOf(groups, t.tag) === group);
  }, [tagsQuery.data, tagsQuery.isError, group, groups, groupsQuery.isError]);
  const groupPicker = groups && (
    <Picker
      value={group ?? ""}
      options={groupOptions(groups)}
      onChange={(g) => navigate(groupHref(g))}
      placeholder="Tag groups"
      aria-label="Open a tag group"
      searchable
    />
  );
  const { data: cov } = useAiCoverage();

  const boilerplateCount = useMemo(
    () => (tags ? tags.filter((t) => isBoilerplate(t.tag)).length : 0),
    [tags, isBoilerplate],
  );
  const { characters, general } = useMemo(
    () =>
      splitSections(
        sortTags(filterTags(tags ?? [], q, showBoilerplate ? null : isBoilerplate), sort),
      ),
    [tags, q, sort, showBoilerplate, isBoilerplate],
  );

  // Escape closes the panel (the rename dialog handles its own Escape first),
  // but not while an image is open over the page: that Escape is the viewer's.
  useHotkeys([{ keys: ["Escape"], mods: "any", run: () => setSelected(null) }], {
    enabled: !!selected,
    fields: true,
    skipHandled: true,
  });

  // --- Rename / merge -------------------------------------------------------
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [renaming, setRenaming] = useState<TagAgg | null>(null);
  const [showRules, setShowRules] = useState(false);
  const { data: aliases } = useTagAliases();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const { data: suggested } = useMergeSuggestions();
  const suggestions = suggested?.suggestions;
  // Stored per-kind tags, so the dialog can tell a rename from a merge.
  const { data: stored } = useTagAggregate({ includePrompt: true });

  const afterTagWrite = () => {
    invalidateFeeds(queryClient);
    queryClient.invalidateQueries({ queryKey: TAG_ALIASES_KEY });
    queryClient.invalidateQueries({ queryKey: MERGE_SUGGESTIONS_KEY });
  };

  const onRename = async (tag: string, to: string) => {
    try {
      const res = await renameTag(tag, to);
      afterTagWrite();
      setSelected(tagName(res.to));
      push(
        `${res.kind === "prompt" ? "Merged" : "Renamed"} “${formatTag(res.from)}” into “${(res.to_all ?? [res.to]).map(formatTag).join(" + ")}” on ${res.images.toLocaleString()} images` +
          (res.background ? ", updating them in the background" : ""),
        "success",
      );
      return true;
    } catch (e) {
      push(`Rename failed: ${errorText(e)}`, "error");
      return false;
    }
  };

  const onUndoRule = async (from: string) => {
    try {
      const res = await deleteTagAlias(from);
      afterTagWrite();
      push(
        `Removed rule “${formatTag(res.from)}” → “${res.to.map(formatTag).join(" + ")}”` +
          (res.background ? ", updating its images in the background" : ""),
        "success",
      );
    } catch (e) {
      push(`Couldn't remove the rule: ${errorText(e)}`, "error");
    }
  };

  const onAcceptSuggestions = async (rules: { from: string; to: string[] }[]) => {
    try {
      const res = await addTagRules(rules);
      afterTagWrite();
      if (res.rules >= rules.length) setShowSuggestions(false);
      push(
        `Merged ${res.rules.toLocaleString()} ${res.rules === 1 ? "tag" : "tags"} on ${res.images.toLocaleString()} images` +
          (res.background ? ", updating them in the background" : "") +
          (res.skipped.length
            ? `; skipped ${res.skipped
                .slice(0, 3)
                .map((s) => `“${formatTag(s.from)}” (${s.reason})`)
                .join(", ")}${res.skipped.length > 3 ? ` and ${res.skipped.length - 3} more` : ""}`
            : ""),
        res.skipped.length ? "info" : "success",
      );
    } catch (e) {
      push(`Merge failed: ${errorText(e)}`, "error");
    }
  };

  // `tags` keeps its identity until the list really changes (a pinned cover,
  // a rename), which is when the mosaics should be fetched again.
  // Characters made by hand have no images (so no Tags-page row); they join
  // the shelf and open their page.
  const { data: everyone } = useCharacters();
  const made = useMemo(
    () => (everyone ?? []).filter((c) => c.count === 0).map((c) => c.tag),
    [everyone],
  );
  const madeRows: BrowseTag[] = useMemo(
    () =>
      filterTags(
        (source === "all" && !group ? made : []).map((tag) => ({
          tag,
          count: 0,
          category: "character" as const,
          last_used: null,
          thumb_image_id: null,
          thumb_url: null,
        })),
        q,
        null,
      ),
    [made, q, source],
  );
  const shelf = useMemo(() => [...characters, ...madeRows], [characters, madeRows]);
  const shownCount = shelf.length + general.length;
  const [creating, setCreating] = useState(false);
  const onSelect = (tag: string) => (made.includes(tag) ? navigate(characterHref(tag)) : setSelected(tag));
  const sectionProps = { view, source, selected, onSelect, epoch: tags, describe };
  return (
    <>
      <PageHeader
        title={group ? groupLabel(group) : "Tags"}
        count={tags?.length}
        width="wide"
        actions={
          group ? (
            <ButtonLink size="sm" variant="ghost" to="/tags">
              All tags
            </ButtonLink>
          ) : (
            <Button size="sm" onClick={() => setCreating(true)}>
              <UserPlus size={14} /> New character
            </Button>
          )
        }
      />
      {creating && <NewCharacterDialog open onClose={() => setCreating(false)} />}
      <PageBody width="wide">
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <div className="relative min-w-[12rem] max-w-md flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input
              className="pl-9"
              placeholder="Filter tags…"
              aria-label="Filter tags"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <ViewSwitch value={view} onChange={setView} />
          {groupPicker}
          <DropdownMenu
            label={`Sort: ${SORT_LABEL[sort]}`}
            aria-label="Sort tags"
            items={(Object.keys(SORT_LABEL) as TagSort[]).map((s) => ({
              label: SORT_LABEL[s],
              onClick: () => setSort(s),
            }))}
          />
          <DropdownMenu
            label={source === "all" ? SOURCE_LABEL.all : `Source: ${SOURCE_LABEL[source]}`}
            aria-label="Which source's tags to show"
            items={(Object.keys(SOURCE_LABEL) as TagSource[]).map((s) => ({
              label: SOURCE_LABEL[s],
              onClick: () => setSource(s),
            }))}
          />
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
          {!group && !!suggestions?.length && (
            <Button
              active={showSuggestions}
              onClick={() => setShowSuggestions((v) => !v)}
              title="Prompt tags Danbooru names otherwise"
            >
              <Wand2 size={15} /> Suggested merges ({suggestions.length.toLocaleString()})
            </Button>
          )}
          {!group && !!aliases?.length && (
            <Button
              active={showRules}
              onClick={() => setShowRules((v) => !v)}
              title="Prompt tags you merged into another name"
            >
              <GitMerge size={15} /> Merge rules ({aliases.length.toLocaleString()})
            </Button>
          )}
        </div>

        {showSuggestions && !!suggestions?.length && (
          <MergeSuggestions suggestions={suggestions} onAccept={onAcceptSuggestions} />
        )}

        {showRules && !!aliases?.length && (
          <div className="mb-6 rounded-xl border border-white/5 bg-surface shadow-panel divide-y divide-white/5">
            {aliases.map((a) => (
              <div key={a.from} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="truncate text-muted">{formatTag(a.from)}</span>
                <span className="text-faint">→</span>
                <span className="truncate font-medium">{a.to.map(formatTag).join(" + ")}</span>
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

        <div
          className={cn(
            "grid gap-6 items-start",
            selected && "lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]",
          )}
        >
          <div className="min-w-0 space-y-6">
            {/* Shortcuts to what still needs work */}
            {!group && <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-3">
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
              <SpecialTile
                title="AI tagged"
                subtitle={
                  cov
                    ? `${cov.ai_tagged.toLocaleString()} ${cov.ai_tagged === 1 ? "image" : "images"} AI-tagged`
                    : "Tagged by the AI"
                }
                to="/?ai_tagged=1"
                icon={<Sparkles size={16} className="text-brand-300" />}
              />
            </div>}

            {tags === null ? (
              <LoadingGrid view={view} />
            ) : shownCount === 0 ? (
              q.trim() ? (
                <EmptyState
                  compact
                  icon={Search}
                  title={`No tags match “${q.trim()}”`}
                  description={
                    source !== "all"
                      ? `Only ${SOURCE_LABEL[source]} tags are shown. Try All sources.`
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
            ) : (
              <>
                {shelf.length > 0 && (
                  <TagSection title="Characters" rows={shelf} {...sectionProps} />
                )}
                {general.length > 0 && (
                  <TagSection
                    title={shelf.length > 0 ? "Tags" : null}
                    rows={general}
                    {...sectionProps}
                  />
                )}
              </>
            )}
          </div>

          {selected && (
            <>
              {/* Below lg the panel is a sheet over the page. */}
              <button
                type="button"
                aria-label="Close tag details"
                onClick={() => setSelected(null)}
                className="lg:hidden fixed inset-0 z-40 bg-black/50"
              />
              <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[400px] overflow-y-auto p-3 lg:p-0 lg:static lg:z-auto lg:max-w-none lg:w-auto lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)]">
                <TagPanel
                  key={selected}
                  tag={selected}
                  source={source}
                  onClose={() => setSelected(null)}
                  onSelect={setSelected}
                  onRename={(tag, count) => setRenaming({ _id: tag, count })}
                />
              </div>
            </>
          )}
        </div>
      </PageBody>
      <RenameTagDialog
        tag={renaming}
        known={stored ?? []}
        onClose={() => setRenaming(null)}
        onRename={onRename}
      />
    </>
  );
}

function ViewSwitch({ value, onChange }: { value: TagView; onChange: (v: TagView) => void }) {
  const options: Array<{ v: TagView; label: string; icon: typeof List }> = [
    { v: "grid", label: "Grid", icon: LayoutGrid },
    { v: "list", label: "List", icon: List },
  ];
  return (
    <div role="group" aria-label="View" className="inline-flex h-9 p-0.5 rounded-lg bg-raised border border-line">
      {options.map(({ v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          title={`${label} view`}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 rounded-md text-sm",
            value === v
              ? "bg-brand-600/25 border border-brand-500/60 text-white"
              : "border border-transparent text-muted hover:text-white",
          )}
        >
          <Icon size={15} />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

function TagSection({
  title,
  rows,
  view,
  source,
  selected,
  onSelect,
  epoch,
  describe,
}: {
  title: string | null;
  rows: BrowseTag[];
  view: TagView;
  source: TagSource;
  selected: string | null;
  onSelect: (tag: string) => void;
  epoch: unknown;
  describe: Describe;
}) {
  const [visible, setVisible] = useState(PAGE[view]);
  // A new filter or view starts the section from its first page again.
  useEffect(() => setVisible(PAGE[view]), [rows, view]);
  const shown = rows.slice(0, visible);
  const max = rows.reduce((m, r) => Math.max(m, r.count), 1);

  return (
    <section aria-label={title ?? "Tags"} className="space-y-3">
      {title && (
        <h2 className="text-sm font-semibold text-muted">
          {title} <span className="text-faint font-normal tabular-nums">{rows.length.toLocaleString()}</span>
        </h2>
      )}
      {view === "grid" ? (
        <TagGrid rows={shown} source={source} selected={selected} onSelect={onSelect} epoch={epoch} describe={describe} />
      ) : (
        <div className="rounded-xl border border-white/5 bg-surface shadow-panel overflow-hidden divide-y divide-white/5">
          {shown.map((t) => (
            <Described key={t.tag} text={describe(t.tag)}>
              <TagRow tag={t} max={max} active={t.tag === selected} onSelect={onSelect} />
            </Described>
          ))}
        </div>
      )}
      {rows.length > visible && (
        <div className="flex justify-center">
          <Button onClick={() => setVisible((v) => v + PAGE[view])}>
            Show more ({(rows.length - visible).toLocaleString()} left)
          </Button>
        </div>
      )}
    </section>
  );
}

/** Mosaic cards; samples are fetched in one batch for the cards on screen. */
function TagGrid({
  rows,
  source,
  selected,
  onSelect,
  epoch,
  describe,
}: {
  rows: BrowseTag[];
  source: TagSource;
  selected: string | null;
  onSelect: (tag: string) => void;
  epoch: unknown;
  describe: Describe;
}) {
  const [samples, setSamples] = useState<Record<string, Sample[]>>({});
  const characters = useCharacterLookup();
  const requested = useRef<Set<string>>(new Set());
  // A changed list (a pinned cover, a rename) starts the mosaics over.
  useEffect(() => {
    requested.current.clear();
    setSamples({});
  }, [epoch]);

  useEffect(() => {
    const need = rows
      .filter((t) => t.category !== "character")
      .map((t) => galleryTag(t.tag, source))
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
  }, [rows, source]);

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(170px,calc(50%_-_6px)),1fr))] gap-3">
      {rows.map((t) =>
        t.category === "character" ? (
          <SpineCard
            key={t.tag}
            tag={t}
            character={characters.get(t.tag)}
            selected={t.tag === selected}
            onSelect={onSelect}
          />
        ) : (
          <Described key={t.tag} text={describe(t.tag)}>
            <NumeralCard
              tag={t}
              samples={samples[galleryTag(t.tag, source)]}
              selected={t.tag === selected}
              onSelect={onSelect}
            />
          </Described>
        ),
      )}
    </div>
  );
}

const CARD =
  "group relative block overflow-hidden border bg-surface shadow-panel text-left card-hover focus-visible:outline-none";
const cardState = (on: boolean) =>
  on ? "border-brand-400 ring-1 ring-brand-400" : "border-white/5";

/**
 * A character as a manga volume on a shelf: their name runs up a spine in
 * their own colour, beside a portrait cropped to their upper body.
 */
function SpineCard({
  tag: t,
  character: c,
  selected,
  onSelect,
}: {
  tag: BrowseTag;
  character: CharacterEntry | undefined;
  selected: boolean;
  onSelect: (tag: string) => void;
}) {
  const colour = c?.color ?? SPINE_NEUTRAL;
  const { name } = displayName(c ?? { tag: t.tag });
  return (
    <button
      type="button"
      onClick={() => onSelect(t.tag)}
      aria-pressed={selected}
      aria-label={`${formatTag(t.tag)}: ${t.count.toLocaleString()} images`}
      className={cn(CARD, "flex", cardState(selected))}
    >
      {/* The spine takes the portrait's height and never sets it: in flow, a
          long name grew the card taller than 3:4 and stretched the portrait,
          whose crop is worked out for exactly 3:4. */}
      <span className="relative w-8 shrink-0" style={{ background: colour }}>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-between gap-2 py-2.5 [writing-mode:vertical-rl] rotate-180",
            "text-xs font-bold uppercase tracking-[0.08em]",
            inkOn(colour) === "dark" ? "text-canvas" : "text-white",
          )}
        >
          <span className="truncate min-h-0">{name}</span>
          <span className="shrink-0 font-mono font-medium text-2xs tracking-normal opacity-75 tabular-nums">
            {t.count.toLocaleString()}
          </span>
        </span>
      </span>
      <FaceCrop
        src={c?.thumb_url ?? t.thumb_url}
        face={c?.face ?? null}
        focus={c?.focus ?? null}
        aspect={c?.aspect ?? null}
        frame={3 / 4}
        zoom={CARD_ZOOM}
        className="flex-1 aspect-[3/4] text-5xl"
        letter={name}
      />
    </button>
  );
}

/** A tag as a collage of its images, its image count a large faint numeral. */
function NumeralCard({
  tag: t,
  samples,
  selected,
  onSelect,
}: {
  tag: BrowseTag;
  samples: Sample[] | undefined;
  selected: boolean;
  onSelect: (tag: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(t.tag)}
      aria-pressed={selected}
      className={cn(CARD, "bg-sheen w-full", cardState(selected))}
    >
      <Mosaic samples={samples} cover={t.thumb_url} focus={t.focus} focusImage={t.thumb_image_id} className="aspect-[3/4]" smallCells />
      <div className="relative overflow-hidden px-3 pt-2.5 pb-3">
        <span
          aria-hidden="true"
          className="absolute -right-1 -bottom-3.5 text-[3.25rem] font-extrabold leading-none tracking-tighter tabular-nums text-white/[0.07]"
        >
          {t.count.toLocaleString()}
        </span>
        <div className="relative text-[15px] font-bold truncate">{formatTag(t.tag)}</div>
        <div className="relative mt-0.5 text-2xs uppercase tracking-[0.08em] text-faint">
          {t.count.toLocaleString()} {t.count === 1 ? "image" : "images"}
        </div>
      </div>
    </button>
  );
}

function TagRow({
  tag,
  max,
  active,
  onSelect,
}: {
  tag: BrowseTag;
  max: number;
  active: boolean;
  onSelect: (tag: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tag.tag)}
      aria-pressed={active}
      className={cn(
        "w-full grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(4rem,10rem)_3.5rem] items-center gap-3 px-3 py-1.5 text-left hover:bg-raised",
        active && "bg-brand-600/15",
      )}
    >
      <span className="h-10 w-10 rounded-md overflow-hidden bg-raised">
        {tag.thumb_url && (
          <img
            src={smallThumb(tag.thumb_url)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            style={{ objectPosition: focusPosition(tag.focus ?? null) }}
          />
        )}
      </span>
      <span className="text-sm font-medium truncate">{formatTag(tag.tag)}</span>
      <span className="h-1.5 rounded-full bg-line overflow-hidden" aria-hidden="true">
        <span
          className="block h-full rounded-full bg-brand-400/80"
          style={{ width: `${Math.max(2, (tag.count / max) * 100)}%` }}
        />
      </span>
      <span className="text-sm text-muted tabular-nums text-right">{tag.count.toLocaleString()}</span>
    </button>
  );
}

/** A hover label with the tag's description, around a card or row. Always
 * the same wrapper, so descriptions arriving late don't remount the cards. */
function Described({ text, children }: { text: string | undefined; children: ReactNode }) {
  return (
    <Tooltip content={text} bubble className="flex min-w-0">
      {children}
    </Tooltip>
  );
}

function LoadingGrid({ view }: { view: TagView }) {
  if (view === "list") {
    return (
      <div className="space-y-1">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(170px,calc(50%_-_6px)),1fr))] gap-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="overflow-hidden border border-white/5 bg-surface shadow-panel">
          <Skeleton className="w-full aspect-[3/4] rounded-none" />
          <div className="p-3 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SpecialTile({
  title,
  subtitle,
  to,
  icon,
}: {
  title: string;
  subtitle: string;
  to: string;
  /** Defaults to a struck-out tag: something missing. */
  icon?: ReactNode;
}) {
  return (
    <Link
      to={to}
      title={title}
      className="rounded-xl border border-white/5 bg-surface bg-sheen shadow-panel px-4 py-3 text-left card-hover min-w-0 sm:min-w-[180px]"
    >
      <div className="flex items-center gap-2 font-semibold">
        <span className="relative inline-flex items-center justify-center w-5 h-5">
          {icon ?? (
            <>
              <TagIcon size={16} />
              <Slash size={16} className="absolute inset-0 text-brand-300" />
            </>
          )}
        </span>
        {title}
      </div>
      <div className="text-xs text-muted mt-0.5">{subtitle}</div>
    </Link>
  );
}
