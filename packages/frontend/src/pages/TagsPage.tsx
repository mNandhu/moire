import { useCallback, useMemo, useState } from "react";
import { useLocalPref } from "../hooks/useLocalPref";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Tag as TagIcon, Search, GitMerge, LayoutGrid, List, UserPlus, Wand2, Sparkles } from "lucide-react";
import { PageHeader, PageBody } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Button, ButtonLink } from "../components/ui/Button";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { Input } from "../components/ui/Input";
import { cn } from "../lib/cn";
import { EVERYWHERE } from "../lib/shortcuts";
import { galleryHref } from "../lib/imageFilter";
import {
  useAiCoverage,
  useBoilerplate,
  useTagAggregate,
  useTagRules,
  useTagBrowse,
  useTagDescriptions,
  useTagGroups,
  useMergeSuggestions,
  type TagAgg,
} from "../lib/queries";
import { descriptionKey } from "../lib/tags";
import { useHotkeys } from "../hooks/useHotkeys";
import { useTagRuleActions } from "../hooks/useTagRuleActions";
import {
  SORT_LABEL,
  SOURCE_LABEL,
  filterTags,
  sortTags,
  splitSections,
  type BrowseTag,
  type TagSort,
  type TagSource,
  type TagView,
} from "../lib/tagBrowse";
import { RenameTagDialog } from "../components/RenameTagDialog";
import { MergeSuggestions } from "../components/MergeSuggestions";
import { MergeRules } from "../components/MergeRules";
import { LoadingGrid, SpecialTile, TagSection, type Describe } from "../components/tags/TagCards";
import { TagPanel } from "../components/TagPanel";
import { useCharacters } from "../lib/queries";
import { NewCharacterDialog } from "../components/NewCharacterDialog";
import { Picker } from "../components/ui/Picker";
import { groupHref, groupLabel, groupOf, groupOptions } from "../lib/tagGroups";
import { characterHref } from "../lib/character";

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
  useHotkeys([{ ...EVERYWHERE.close, mods: "any", run: () => setSelected(null) }], {
    enabled: !!selected,
    fields: true,
    skipHandled: true,
  });

  // --- Rename / merge -------------------------------------------------------
  const [renaming, setRenaming] = useState<TagAgg | null>(null);
  const [showRules, setShowRules] = useState(false);
  const { data: mergeRules } = useTagRules();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const { data: suggested } = useMergeSuggestions();
  const suggestions = suggested?.suggestions;
  // Stored per-kind tags, so the dialog can tell a rename from a merge.
  const { data: stored } = useTagAggregate({ includePrompt: true });
  const { rename: onRename, undoRule: onUndoRule, acceptSuggestions: onAcceptSuggestions } = useTagRuleActions({
    onRenamed: setSelected,
    onAllAccepted: () => setShowSuggestions(false),
  });

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
    [made, q, source, group],
  );
  const shelf = useMemo(() => [...characters, ...madeRows], [characters, madeRows]);
  const shownCount = shelf.length + general.length;
  const [creating, setCreating] = useState(false);
  const onSelect = (tag: string) => (made.includes(tag) ? navigate(characterHref(tag)) : setSelected(tag));
  const sectionProps = { view, source, selected, onSelect, describe };
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
          {!group && !!mergeRules?.length && (
            <Button
              active={showRules}
              onClick={() => setShowRules((v) => !v)}
              title="Prompt tags you merged into another name"
            >
              <GitMerge size={15} /> Merge rules ({mergeRules.length.toLocaleString()})
            </Button>
          )}
        </div>

        {showSuggestions && !!suggestions?.length && (
          <MergeSuggestions suggestions={suggestions} onAccept={onAcceptSuggestions} />
        )}

        {showRules && !!mergeRules?.length && (
          <MergeRules rules={mergeRules} onUndo={(from) => void onUndoRule(from)} />
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
                    ? `${cov.no_tags.toLocaleString()} ${cov.no_tags === 1 ? "image" : "images"} with no AI or manual tags`
                    : "No AI or manual tags"
                }
                to={galleryHref({ noTags: true })}
              />
              <SpecialTile
                title="Missing AI tags"
                subtitle={
                  cov
                    ? `${cov.untagged.toLocaleString()} ${cov.untagged === 1 ? "image" : "images"} not AI-tagged`
                    : "Not yet AI-tagged"
                }
                to={galleryHref({ noAiTags: true })}
              />
              <SpecialTile
                title="AI tagged"
                subtitle={
                  cov
                    ? `${cov.ai_tagged.toLocaleString()} ${cov.ai_tagged === 1 ? "image" : "images"} AI-tagged`
                    : "Tagged by the AI"
                }
                to={galleryHref({ aiTagged: true })}
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
