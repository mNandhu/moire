import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { VirtualizedGrid } from "../components/VirtualizedGrid";
import { GallerySkeleton } from "../components/GallerySkeleton";
import { DensityControl } from "../components/DensityControl";
import { openShortcutHelp } from "../lib/shortcuts";
import { useToast } from "../components/Toasts";
import { SHORTCUT_HINT_KEY } from "../lib/onboarding";
import { readLocalPref, writeLocalPref } from "../lib/localPref";
import { useConfirm } from "../components/ConfirmDialog";
import { BulkTagDialog } from "../components/BulkTagDialog";
import {
  Filter,
  Keyboard,
  CheckSquare,
  Square,
  ImageOff,
  Sparkles,
  Layers,
  ArrowLeft,
  ShieldOff,
  ShieldCheck,
  Tags,
  X,
  FolderSearch,
  SlidersHorizontal,
  Check,
} from "lucide-react";
import {
  DEFAULT_FILTERS,
  serializeFilters,
  serializeFiltersForPeek,
  hasActiveFilter,
  hasClearableFilter,
  withoutFilters,
  type Filters,
  activeFilterChips,
  RESOURCE_PREFIXES,
  searchTerms,
  withSearchTerms,
} from "../lib/imageFilter";
import { PageHeader } from "../components/ui/PageHeader";
import { LibraryScopeTabs } from "../components/LibraryScopeTabs";
import { SortControl, SORT_OPTIONS } from "../components/SortControl";
import { fetchSignatures } from "../lib/gen";
import { groupWorkflows, workflowFilterName } from "../lib/workflows";
import { useGenerators, useOutfits } from "../lib/generate";
import { generatorFor } from "../components/generate/InGenerate";
import { Badge } from "../components/ui";
import { ambientPalette } from "../lib/blurhash";
import { applyAmbient } from "../lib/ambient";
import { TAGS_KEY, imageEmbeddingsQuery, imageLorasQuery, imageModelsQuery } from "../lib/queries";
import { feedNeedsRefetch, useLibraries, useOnLibrariesRead } from "../lib/libraries";
import { Button, ButtonLink } from "../components/ui/Button";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { Picker } from "../components/ui/Picker";
import { EmptyState } from "../components/ui/EmptyState";
import { SizeFilter } from "../components/SizeFilter";
import {
  TagSearchInput,
  type TagSuggestion,
} from "../components/TagSearchInput";
import { useFilters } from "../hooks/useFilters";
import { useSelectionMode } from "../hooks/useSelectionMode";
import { useDensity } from "../hooks/useDensity";
import {
  useImageFeed,
  useImageGroups,
} from "../hooks/useImageFeed";
import { useScrollRestoration } from "../hooks/useScrollRestoration";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PAGE_LIMIT, type ImageDoc } from "../lib/imageFilter";
import { nextFocusIndex, isGridNavKey, type GridNavKey } from "../lib/gridNav";
import { FETCH_AHEAD_PX, gridColumns } from "../lib/masonryLayout";
import { runBulk } from "../lib/bulk";
import {
  setScore as apiSetScore,
  setQuarantine as apiSetQuarantine,
  bulkManualTags,
} from "../lib/imageMutations";
import { api, errorText } from "../lib/api";
import { useDismiss } from "../hooks/useDismiss";
import { useHotkeys } from "../hooks/useHotkeys";
import { withBackgroundLocation } from "../lib/backgroundLocation";
import { postAiTag } from "../lib/ai";
import {
  imageDocKey,
  invalidateFeeds,
  patchFeeds,
  patchImageEverywhere,
  removeImagesFromFeeds,
} from "../lib/feedCache";

// Stable empties so the query defaults don't hand children a new array on
// every render.
const NO_TAGS: TagSuggestion[] = [];
const NO_MODELS: { model: string; count: number }[] = [];
const NO_LORAS: { name: string; count: number }[] = [];
/** `f` without its library scope (a tab, not a filter). */
const withoutLibrary = (f: Filters): Filters => ({ ...f, libraryId: undefined });

const LOGIC_OPTIONS = {
  tags: [
    { value: "and", label: "Match all tags (AND)" },
    { value: "or", label: "Match any tag (OR)" },
  ],
  prompt: [
    { value: "and", label: "Match all terms (AND)" },
    { value: "or", label: "Match any term (OR)" },
  ],
};

export default function AllImagesPage() {
  const { push } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  // ImageView opens as an overlay on top of this page rather than routing in
  // place of it (see RootRoutes), so this page never unmounts while it's
  // open, its global key listeners (useHotkeys) bail instead, or they would keep
  // acting on the backgrounded grid while ImageView is also handling keys.

  // Image filter (URL is the single source of truth) and the Image feed it drives.
  const [filters, setFilters] = useFilters();
  // Grouped (batch-collapsed) view: active only when collapsing AND not drilled
  // into a specific batch. Drilling in (groupId) shows that batch ungrouped.
  const groupMode = filters.group && !filters.groupId;
  const feed = useImageFeed(filters, PAGE_LIMIT, !groupMode);
  const groups = useImageGroups(filters, groupMode);
  const activeFeed = groupMode ? groups : feed;
  const items = activeFeed.items;

  // Tint the app with the strongest hues among the first images in the feed.
  useEffect(() => {
    applyAmbient(ambientPalette(items.slice(0, 24).map((it) => it.blurhash)));
  }, [items]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const queryClient = useQueryClient();
  // Slow idle poll, brisk while a scan runs: catches scans and watcher events
  // started elsewhere while the gallery stays open.
  const libsQuery = useLibraries({ idleMs: 8000 });
  const libs = useMemo(() => libsQuery.data ?? [], [libsQuery.data]);
  // Workflows for the filter picker and the chip's name, grouped as the Rules
  // page groups them. Fetched once the panel opens or a workflow is filtered.
  const { data: signatures } = useQuery({
    queryKey: ["rules-signatures"],
    queryFn: fetchSignatures,
    enabled: filtersOpen || !!filters.workflow || !!filters.workflowSig,
    staleTime: 60_000,
  });
  const workflowFamilies = useMemo(() => groupWorkflows(signatures ?? []), [signatures]);

  // The library is shown by the scope tabs, so it isn't repeated as a chip
  // (or counted on the filter button), unless no tab can show it: the tabs
  // are hidden, or the URL names a library that no longer exists (a stale
  // link), which would otherwise leave an empty feed with nothing to clear.
  const scopeInTabs =
    libs.length >= 2 && libs.some((l) => l._id === filters.libraryId);
  const filterChips = useMemo(
    () =>
      activeFilterChips(
        filters,
        (id) => {
          const lib = libs.find((l) => l._id === id);
          return lib ? lib.name || lib.path : libs.length ? "not found" : undefined;
        },
        (key) => workflowFilterName(workflowFamilies, key),
      ).filter((chip) => chip.key !== "library" || !scopeInTabs),
    [filters, libs, workflowFamilies, scopeInTabs],
  );

  // An empty feed while its library is still scanning (or queued) is not
  // "no images": say so. Only with no filter set, where empty means the
  // library itself has nothing yet.
  const emptyScan = useMemo(() => {
    if (hasActiveFilter(withoutLibrary(filters))) return null;
    const scanning = libs.filter(
      (l) => l.scanning && (!filters.libraryId || l._id === filters.libraryId),
    );
    if (!scanning.length) return null;
    const one = scanning.length === 1 ? scanning[0] : null;
    return {
      title: one ? `Scanning ${one.name || one.path}` : "Scanning your libraries",
      progress:
        one?.scan_total
          ? `${(one.scan_done ?? 0).toLocaleString()} of ${one.scan_total.toLocaleString()} files read. `
          : "",
    };
  }, [filters, libs]);

  // Known tags (with image counts) powering the search autocomplete.
  // merge_sources collapses the three sources of each tag (AI / manual /
  // prompt) into one cross-source `any:<base>` suggestion so the dropdown
  // shows a single "tag1" row instead of three near-duplicates; the count is
  // distinct images (a tag applied from two sources isn't double-counted).
  // Selecting it matches images tagged from any source (the backend expands
  // `any:`).
  const { data: tagOptions = NO_TAGS } = useQuery({
    queryKey: [...TAGS_KEY, { merged: true }],
    queryFn: ({ signal }) =>
      api<TagSuggestion[]>(
        `/api/v1/tags?include_manual=1&include_prompt=1&merge_sources=1`,
        { signal },
      ),
  });
  // Distinct checkpoints (with counts) for the model filter dropdown.
  const { data: modelOptions = NO_MODELS } = useQuery(imageModelsQuery);
  // Distinct embeddings (with counts) for the embedding filter dropdown.
  const { data: embeddingOptions = NO_LORAS } = useQuery(imageEmbeddingsQuery);
  // Distinct loras (with counts) for the LoRA filter dropdown.
  const { data: loraOptions = NO_LORAS } = useQuery(imageLorasQuery);
  // Loras and embeddings as search terms: suggested in the search box, and
  // typed names resolved to the library's spelling (matching is exact).
  // Saved outfits too: typing a name offers them, and a plain name that is
  // an outfit (and not a tag) becomes the outfit filter.
  const { data: outfitList } = useOutfits();
  const knownOutfits = useMemo(() => (outfitList ?? []).map((o) => ({ id: o._id, name: o.name })), [outfitList]);
  const tagNames = useMemo(() => new Set(tagOptions.map((t) => t._id.slice(t._id.indexOf(":") + 1))), [tagOptions]);
  const resourceSuggestions = useMemo(
    () => [
      ...loraOptions.map((o) => ({ _id: RESOURCE_PREFIXES.lora + o.name, count: o.count })),
      ...embeddingOptions.map((o) => ({ _id: RESOURCE_PREFIXES.embedding + o.name, count: o.count })),
      ...knownOutfits.map((o) => ({ _id: RESOURCE_PREFIXES.outfit + o.name, count: 0 })),
    ],
    [loraOptions, embeddingOptions, knownOutfits],
  );
  const knownResources = useMemo(
    () => ({ lora: loraOptions.map((o) => o.name), embedding: embeddingOptions.map((o) => o.name) }),
    [loraOptions, embeddingOptions],
  );
  const { data: generators } = useGenerators();
  // A workflow set up to run in Generate says so beside its count.
  const countHint = (n: number, inGenerate: boolean) =>
    inGenerate ? (
      <span className="inline-flex items-center gap-2">
        <Badge tone="brand" className="px-1.5 text-2xs">
          In Generate
        </Badge>
        {n.toLocaleString()}
      </span>
    ) : (
      n.toLocaleString()
    );
  const workflowPickerOptions = useMemo(
    () => [
      { value: "", label: "Any workflow" },
      ...workflowFamilies.flatMap((fam) => [
        ...(fam.id
          ? [
              {
                value: `w:${fam.id}`,
                label: fam.versions.length > 1 ? `${fam.name}, all ${fam.versions.length} versions` : fam.name,
                hint: countHint(fam.images, !!generatorFor(generators, { family: fam.id })),
                group: fam.name,
              },
            ]
          : []),
        ...(fam.versions.length > 1 || !fam.id
          ? fam.versions.map((v) => ({
              value: `s:${v.row.workflow_sig}`,
              label: v.note ? `${v.title} · ${v.note}` : v.title,
              hint: countHint(v.row.count, !!generatorFor(generators, { sig: v.row.workflow_sig })),
              group: fam.name,
              indent: !!fam.id,
              keywords: fam.name,
            }))
          : []),
      ]),
    ],
    [workflowFamilies, generators],
  );

  const {
    selection,
    selectionMode,
    setSelectionMode,
    selectionActive,
    toggle: toggleSelection,
    clear: clearSelection,
    selectOnly,
  } = useSelectionMode();
  // Every image the filter matches, not just the loaded pages. Hidden in the
  // grouped view, where a tile stands for a batch and picking one picks only
  // its representative.
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAll = async () => {
    setSelectingAll(true);
    try {
      const got = await api<{ ids: string[]; truncated: boolean }>(
        `/api/v1/images/ids?${serializeFilters(filters)}`,
      );
      selectOnly(got.ids);
      if (got.truncated) {
        push(`Selected the first ${got.ids.length.toLocaleString()} images; narrow the filter for the rest`, "info");
      }
    } catch (e) {
      push(`Couldn't select all: ${errorText(e)}`, "error");
    } finally {
      setSelectingAll(false);
    }
  };
  const density = useDensity();

  // Keyboard triage: index of the focused tile (-1 = none). Disabled in
  // selection mode and in the grouped view (tiles there are batch reps).
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The grid's own box, not the padded page wrapper. Arrow-key row jumps have
  // to step by the number of columns the grid actually packed, which means
  // measuring the same element at the same density the grid measures, a
  // padded parent's clientWidth is ~48px wider and rounds to a different
  // column count at some widths.
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Filter popover (kept inside the sticky header so it stays accessible while scrolling)
  const headerRef = useRef<HTMLDivElement | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement | null>(null);
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const getScrollContainer = useCallback(() => {
    return (
      (containerRef.current?.closest(".overflow-auto") as HTMLElement | null) ||
      containerRef.current
    );
  }, []);
  const scrollRootOrViewport = useCallback(
    () =>
      (containerRef.current?.closest(".overflow-auto") as HTMLElement | null) ??
      null,
    [],
  );

  // Scroll restoration keyed by the active filter. The hook only saves and
  // hands back the offset; the grid applies it, because only the grid knows
  // when it has packed a height to scroll within.
  const { save: saveScroll, restore: restoreScroll } = useScrollRestoration(
    serializeFilters(filters).toString(),
    getScrollContainer,
  );

  // Indexing runs as an async background scan/watcher, so images land after
  // a library is added/rescanned/changed on disk. This page is the only one
  // that watches the library list (useLibraries above) for scan and watcher
  // activity and refetches the feed as images arrive, so no full reload is
  // needed. See feedNeedsRefetch for when a read of the list pulls the feed.
  // The visible one: the grouped view when grouping, else the flat feed.
  const refetchFeedRef = useRef(activeFeed.refetch);
  refetchFeedRef.current = activeFeed.refetch;
  useOnLibrariesRead(libsQuery, (prev, next) => {
    if (feedNeedsRefetch(prev, next)) refetchFeedRef.current();
  });

  // Close filters on outside click / ESC.
  useDismiss([filtersPanelRef, filterButtonRef], () => setFiltersOpen(false), filtersOpen);

  // Once, right after first-run setup: say where the shortcuts are.
  useEffect(() => {
    if (readLocalPref(SHORTCUT_HINT_KEY) !== "1") return;
    writeLocalPref(SHORTCUT_HINT_KEY, null);
    push("Press ? to see keyboard shortcuts", { type: "info", durationMs: 8000 });
  }, [push]);

  // Global shortcuts: S selection mode, F/"/" focus search, N no-tags,
  // A no-AI-tags, Q quarantined, +/- zoom (? help is global: ShortcutHelp).
  useHotkeys([
    {
      keys: ["+", "="],
      run: (e) => {
        e.preventDefault();
        density.zoomIn();
      },
    },
    {
      keys: ["-", "_"],
      run: (e) => {
        e.preventDefault();
        density.zoomOut();
      },
    },
    {
      keys: ["/", "f", "F"],
      run: (e) => {
        e.preventDefault();
        searchInputRef.current?.focus();
      },
    },
    {
      // One key backs out of whatever is engaged, outermost first. The
      // overlay is handled above, before the bail.
      keys: ["Escape"],
      run: () => {
        if (selectionMode) setSelectionMode(false);
        else setFocusedIndex(-1);
      },
    },
    {
      keys: ["s", "S"],
      run: (e) => {
        e.preventDefault();
        setSelectionMode((v) => {
          const next = !v;
          push(next ? "Selection mode ON" : "Selection mode OFF", "info");
          return next;
        });
      },
    },
    {
      keys: ["n", "N"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.noTags;
        push(next ? "No-tags filter ON" : "No-tags filter OFF", "info");
        setFilters({ ...filters, noTags: next, aiTagged: next ? false : filters.aiTagged });
      },
    },
    {
      keys: ["a", "A"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.noAiTags;
        push(next ? "No-AI-tags filter ON" : "No-AI-tags filter OFF", "info");
        setFilters({ ...filters, noAiTags: next, aiTagged: next ? false : filters.aiTagged });
      },
    },
    {
      keys: ["q", "Q"],
      run: (e) => {
        e.preventDefault();
        const next = !filters.quarantined;
        push(next ? "Showing quarantined" : "Showing active feed", "info");
        setFilters({ ...filters, quarantined: next });
      },
    },
  ]);

  // A selection belongs to the feed it was made in: changing the filter swaps
  // the feed under it, leaving a count over tiles that are no longer on screen
  // and a Quarantine action aimed at images the user can't see. Leaving
  // selection mode is what drops the selection (see useSelectionMode).
  const filterKey = serializeFilters(filters).toString();
  // Scopes each tile's batch-peek fetch to the same members the grouped feed
  // considered when it picked that tile as the representative.
  const peekQuery = useMemo(() => serializeFiltersForPeek(filters), [filters]);
  const lastFilterKeyRef = useRef(filterKey);
  useEffect(() => {
    if (lastFilterKeyRef.current === filterKey) return;
    lastFilterKeyRef.current = filterKey;
    setSelectionMode(false);
  }, [filterKey, setSelectionMode]);

  const openImage = useCallback(
    (id: string) => {
      saveScroll();
      const sp = serializeFilters(filters);
      navigate(`/image/${encodeURIComponent(id)}?${sp.toString()}`, {
        state: withBackgroundLocation(location),
      });
    },
    [filters, navigate, location, saveScroll],
  );


  // Infinite scroll: fetch the next page (feed or grouped view) once the
  // sentinel comes within FETCH_AHEAD_PX of the viewport. The root must be the
  // real scroll element: rootMargin only expands the root, and the page's
  // scroll container would clip a margin set on the document viewport.
  useEffect(() => {
    if (!activeFeed.hasNextPage || activeFeed.isFetchingNextPage) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) activeFeed.fetchNextPage();
      },
      {
        // Without a scrolling ancestor, getScrollContainer falls back to the
        // page's own wrapper, which contains the sentinel: as the root it
        // would always intersect and page in everything. Use the viewport.
        root: scrollRootOrViewport(),
        rootMargin: `0px 0px ${FETCH_AHEAD_PX}px 0px`,
      },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [
    activeFeed.hasNextPage,
    activeFeed.isFetchingNextPage,
    activeFeed.fetchNextPage,
    scrollRootOrViewport,
  ]);

  // Open a tile: in grouped view, clicking a batch (>1) drills into its members
  // instead of opening the representative image.
  const openTile = useCallback(
    (id: string) => {
      if (groupMode) {
        const it = items.find((x) => x._id === id);
        if (it && (it.group_count ?? 1) > 1 && it.group_id) {
          setFilters({ ...filters, group: false, groupId: it.group_id });
          return;
        }
      }
      openImage(id);
    },
    [groupMode, items, filters, setFilters, openImage],
  );
  // Tiles are memoized, and `openTile` changes with every page append (new
  // `items`) and navigation (new `location`), which re-rendered every mounted
  // tile. They get a stable wrapper that calls the latest one.
  const openTileRef = useRef(openTile);
  openTileRef.current = openTile;
  const onOpenTile = useCallback((id: string) => openTileRef.current(id), []);

  // --- Keyboard triage on the focused tile -----------------------------------
  const triageEnabled = !selectionMode && !groupMode;

  // Optimistically patch the feed cache so a score/quarantine shows instantly.
  // Patches every cached feed, not just the current filter; the same image can
  // be cached under several.
  const patchFeed = useCallback(
    (mut: (pages: ImageDoc[][]) => ImageDoc[][]) => patchFeeds(queryClient, mut),
    [queryClient],
  );

  const triageScore = useCallback(
    async (n: number) => {
      const it = items[focusedIndex];
      if (!it) return;
      // Every cached copy, the open-image document included, so ImageView
      // shows the new score too; undone if the write fails.
      const undo = patchImageEverywhere(queryClient, it._id, { score: n });
      try {
        await apiSetScore(it._id, n);
        // Again on success: a feed refetch that was already in flight (after
        // a bulk action, say) may have brought the old score back meanwhile.
        patchImageEverywhere(queryClient, it._id, { score: n });
      } catch (e) {
        undo();
        push(`Failed to set score: ${errorText(e)}`, "error");
      }
    },
    [items, focusedIndex, queryClient, push],
  );

  const triageQuarantine = useCallback(async () => {
    const it = items[focusedIndex];
    if (!it) return;
    // Default feed quarantines; the quarantined view restores. Either way the
    // tile leaves the current list, so drop it and keep focus in range.
    const next = !filters.quarantined;
    patchFeed((pages) => pages.map((pg) => pg.filter((x) => x._id !== it._id)));
    setFocusedIndex((i) => Math.min(i, items.length - 2));
    try {
      await apiSetQuarantine(it._id, next);
      push(next ? "Quarantined" : "Restored", "info");
    } catch (e) {
      push(`Failed: ${errorText(e)}`, "error");
      feed.refetch();
    }
  }, [items, focusedIndex, filters.quarantined, patchFeed, push, feed]);

  useEffect(() => {
    if (!triageEnabled) setFocusedIndex(-1);
  }, [triageEnabled]);

  useHotkeys(
    [
      {
        match: (e) => isGridNavKey(e.key),
        run: (e) => {
          e.preventDefault();
          const key = e.key as GridNavKey;
          const cols = gridColumns(gridWrapRef.current?.clientWidth || 0, density.density);
          setFocusedIndex((prev) => nextFocusIndex(prev, key, cols, items.length));
        },
      },
      {
        match: (e) => e.key >= "0" && e.key <= "5",
        run: (e) => {
          if (focusedIndex < 0) return;
          e.preventDefault();
          void triageScore(Number(e.key));
        },
      },
      {
        keys: ["x", "X", "Delete"],
        run: (e) => {
          if (focusedIndex < 0) return;
          e.preventDefault();
          void triageQuarantine();
        },
      },
      {
        // The tile that receives focus is ThumbnailTile's wrapper <div
        // tabIndex={-1}>, not the inner <button>, so there is no default
        // activation to fall back on, arrowing to a tile and pressing Enter
        // did nothing at all.
        keys: ["Enter"],
        run: (e) => {
          const it = focusedIndex >= 0 ? items[focusedIndex] : undefined;
          if (!it) return;
          e.preventDefault();
          openTile(it._id);
        },
      },
    ],
    { enabled: triageEnabled },
  );

  // --- Bulk actions ----------------------------------------------------------
  //
  // These still go through runBulk rather than Promise.all: a thousand selected
  // images used to mean a thousand simultaneous requests at a single-writer
  // SQLite backend, and one rejection hid which writes had already landed.
  // Bounded concurrency plus a per-id account is strictly better, and costs the
  // caller nothing.
  const runBulkQuarantine = useCallback(
    async (ids: string[], next: boolean) => {
      const verb = next ? "Quarantine" : "Restore";
      const ok = await confirm({
        title: `${verb} ${ids.length} selected image${ids.length === 1 ? "" : "s"}?`,
        message: next
          ? "Quarantined images are hidden from the gallery until restored."
          : undefined,
        confirmLabel: verb,
        tone: next ? "warning" : "default",
      });
      if (!ok) return;
      // Either way the tiles leave the current list, so drop them from the
      // cached feeds and the grid updates without a refresh, the way
      // single-image triage does.
      removeImagesFromFeeds(queryClient, ids);
      const res = await runBulk(ids, (id) => apiSetQuarantine(id, next));
      invalidateFeeds(queryClient);

      if (res.failed.length) {
        // Stay in selection mode on a partial failure. Leaving it drops the
        // selection (see useSelectionMode), which would report "912 done, 88
        // failed" and simultaneously throw away the only handle on those 88.
        push(`${res.ok.length} done, ${res.failed.length} failed`, "error");
        return;
      }
      setSelectionMode(false);
      push(
        `${next ? "Quarantined" : "Restored"} ${ids.length} image${ids.length === 1 ? "" : "s"}`,
        "success",
      );
    },
    [queryClient, setSelectionMode, push, confirm],
  );

  const runBulkTag = useCallback(
    async (ids: string[]) => {
      const ok = await confirm({
        title: `Run AI tagging for ${ids.length} selected image${ids.length === 1 ? "" : "s"}?`,
        confirmLabel: "Run tagging",
      });
      if (!ok) return;
      try {
        await postAiTag(ids);
        push(`Queued AI tagging for ${ids.length} images`, "success");
        setSelectionMode(false);
      } catch (e) {
        push(`Failed to start AI job: ${errorText(e)}`, "error");
      }
    },
    [push, setSelectionMode, confirm],
  );

  // One request, one transaction (see image_tags.bulk_manual), so unlike
  // quarantine there is no partial failure to keep the selection for. It stays
  // anyway: tagging the keepers is usually followed by acting on the rest.
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const runBulkManualTags = useCallback(
    async (edit: { add: string[]; remove: string[] }) => {
      const ids = Array.from(selection);
      try {
        const res = await bulkManualTags(ids, edit);
        invalidateFeeds(queryClient);
        // ImageView reads the full doc from its own cache entry.
        for (const id of ids) {
          queryClient.invalidateQueries({ queryKey: imageDocKey(id), exact: true });
        }
        push(
          `Updated tags on ${res.modified} of ${ids.length} image${ids.length === 1 ? "" : "s"}`,
          "success",
        );
        return true;
      } catch (e) {
        push(`Failed to update tags: ${errorText(e)}`, "error");
        return false;
      }
    },
    [selection, queryClient, push],
  );

  useEffect(() => {
    if (focusedIndex < 0) return;
    const sc = getScrollContainer();
    const focusEl = () => {
      const el = sc?.querySelector(
        `[data-tile-index="${focusedIndex}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.focus?.({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
      }
      return !!el;
    };
    if (!focusEl()) {
      const id = setTimeout(focusEl, 80);
      return () => clearTimeout(id);
    }
  }, [focusedIndex, getScrollContainer]);

  // Grouped view, as both the desktop button and the phone menu show it.
  // Inside one batch (groupId) the feed isn't grouped, so the toggle turns
  // grouping on rather than off.
  const grouped = filters.group && !filters.groupId;
  const toggleGroup = () =>
    setFilters({ ...filters, group: !grouped, groupId: undefined });

  return (
    <div ref={containerRef}>
      {/* One sticky band: title, search and every view control in a single
          64px row (the sidebar's brand row is the same height), with active
          filter chips or the filter panel folding out beneath it. */}
      <div
        ref={headerRef}
        className="sticky top-0 z-10 bg-canvas/85 backdrop-blur-md border-b border-line shadow-bar"
      >
      <PageHeader
        sticky={false}
        width="full"
        title={
          filters.quarantined
            ? "Quarantined Images"
            : filters.groupId
              ? "Batch Images"
              : filters.libraryId
                ? (libs.find((l) => l._id === filters.libraryId)?.name ??
                  libs.find((l) => l._id === filters.libraryId)?.path ??
                  "Library Images")
                : hasActiveFilter(filters)
                  ? "Filtered Images"
                  : "All Images"
        }
        // Not a total: the feed is cursor-paged and the API exposes no count,
        // so this is what has been loaded so far. Labelling it plainly beats a
        // bare number that climbs as you scroll and looks like a bug.
        count={items.length}
        countLabel="loaded"
        description={selectionMode ? `${selection.size} selected` : undefined}
        actions={
          <>
            <DensityControl
              onZoomIn={density.zoomIn}
              onZoomOut={density.zoomOut}
              atMin={density.atMin}
              atMax={density.atMax}
            />
            <Button
              size="icon"
              variant="ghost"
              className="hidden md:inline-flex"
              onClick={openShortcutHelp}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard size={18} />
            </Button>
          </>
        }
      >
        <div className="flex flex-wrap md:flex-nowrap items-center gap-2">
          <Button
            ref={filterButtonRef}
            size="icon"
            variant="secondary"
            active={filtersOpen || filterChips.length > 0}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-label={filtersOpen ? "Hide filters" : "Show filters"}
            title={filtersOpen ? "Hide filters" : "Show filters"}
            className="relative"
          >
            <Filter size={18} />
            {filterChips.length > 0 && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-2xs font-semibold leading-[18px] tabular-nums">
                {filterChips.length}
              </span>
            )}
          </Button>
          <div className="flex-1 min-w-0">
            <TagSearchInput
              ref={searchInputRef}
              value={searchTerms(filters, knownOutfits)}
              onChange={(terms) =>
                setFilters(withSearchTerms(filters, terms, knownResources, { list: knownOutfits, tags: tagNames }))
              }
              suggestions={tagOptions}
              resources={resourceSuggestions}
              placeholder="Search tags, outfits, lora:, embedding:…"
            />
          </div>
          {/* Phones: sort, grouping and selection fold into one menu so the
              search keeps the row. */}
          <div className="md:hidden">
            <DropdownMenu
              aria-label="View options"
              icon={<SlidersHorizontal size={18} />}
              items={[
                ...SORT_OPTIONS.map((o) => ({
                  group: "Sort",
                  label: o.hint,
                  icon: <o.icon size={15} />,
                  hint: filters.sort === o.value ? <Check size={15} /> : undefined,
                  onClick: () => setFilters({ ...filters, sort: o.value }),
                })),
                {
                  group: "View",
                  label: "Group batches",
                  icon: <Layers size={15} />,
                  hint: grouped ? <Check size={15} /> : undefined,
                  onClick: toggleGroup,
                },
                {
                  group: "View",
                  label: selectionMode ? "Done selecting" : "Select",
                  icon: selectionMode ? <CheckSquare size={15} /> : <Square size={15} />,
                  onClick: () => setSelectionMode((v) => !v),
                },
              ]}
            />
          </div>
          <div className="hidden md:flex items-center gap-2">
          <SortControl
            value={filters.sort}
            onChange={(sort) => setFilters({ ...filters, sort })}
          />
          <Button
            size="icon"
            variant="secondary"
            active={grouped}
            onClick={toggleGroup}
            aria-label={grouped ? "Ungroup batches" : "Group batches"}
            title="Group batches (same prompt + workflow)"
            className="xl:w-auto xl:px-3 xl:gap-2"
          >
            <Layers size={18} />
            <span className="hidden xl:inline">Group</span>
          </Button>
          <Button
            size="icon"
            variant="secondary"
            active={selectionMode}
            onClick={() => setSelectionMode((v) => !v)}
            aria-label={
              selectionMode ? "Exit selection mode" : "Enter selection mode"
            }
            title={selectionMode ? "Done selecting" : "Select (S)"}
            className="xl:w-auto xl:px-3 xl:gap-2"
          >
            {selectionMode ? <CheckSquare size={18} /> : <Square size={18} />}
            <span className="hidden xl:inline">{selectionMode ? "Done" : "Select"}</span>
          </Button>
          </div>
          {selectionMode && (
          <div className="w-full md:w-auto flex items-center gap-2">
          <Button
            variant="secondary"
            className="md:hidden"
            onClick={() => setSelectionMode(false)}
          >
            Done
          </Button>
          {!grouped && (
            <Button
              variant="secondary"
              onClick={() => (selectionActive ? clearSelection() : void selectAll())}
              disabled={selectingAll}
              title={selectionActive ? "Clear the selection" : "Select every image this search and filter match"}
            >
              {selectingAll ? "Selecting…" : selectionActive ? "Select none" : "Select all"}
            </Button>
          )}
          {selectionActive && (
            <DropdownMenu
              label={<>{selection.size} selected</>}
              items={[
                {
                  label: "Edit tags",
                  icon: <Tags size={15} />,
                  onClick: () => setBulkTagOpen(true),
                },
                {
                  label: "AI tag",
                  icon: <Sparkles size={15} />,
                  onClick: () => void runBulkTag(Array.from(selection)),
                },
                {
                  // Mirrors single-image triage: the default feed quarantines,
                  // the quarantined view restores.
                  label: filters.quarantined ? "Restore" : "Quarantine",
                  icon: filters.quarantined ? (
                    <ShieldCheck size={15} />
                  ) : (
                    <ShieldOff size={15} />
                  ),
                  variant: filters.quarantined ? "default" : "danger",
                  onClick: () =>
                    void runBulkQuarantine(
                      Array.from(selection),
                      !filters.quarantined,
                    ),
                },
              ]}
            />
          )}
          </div>
          )}
        </div>

      </PageHeader>
      <BulkTagDialog
        open={bulkTagOpen}
        count={selection.size}
        onClose={() => setBulkTagOpen(false)}
        onApply={runBulkManualTags}
      />
      <LibraryScopeTabs
        libraries={libs}
        value={filters.libraryId}
        onChange={(libraryId) => setFilters({ ...filters, libraryId, groupId: undefined })}
      />
      <div className="px-4 md:px-6 empty:hidden">
        {/* With the panel closed, active filters would otherwise be invisible
            (the title changing to "Filtered Images" was the only hint). */}
        {!filtersOpen && filterChips.length > 0 && (
          <div className="pt-3 pb-3 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
            {filterChips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-brand-600/15 border border-brand-500/40 text-xs text-brand-100"
              >
                {chip.label}
                <button
                  type="button"
                  onClick={() => setFilters(chip.without)}
                  aria-label={`Remove filter: ${chip.label}`}
                  title="Remove filter"
                  className="inline-flex items-center justify-center h-5 w-5 rounded-full text-brand-200 hover:text-white hover:bg-brand-500/30"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
            {filterChips.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilters(withoutFilters(filters))}
              >
                Clear all
              </Button>
            )}
          </div>
        )}

        {filtersOpen && (
          <div
            ref={filtersPanelRef}
            className="pt-1 pb-4"
            role="dialog"
            aria-label="Filters"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1.5">
                  Tag logic
                </label>
                <Picker
                  aria-label="Tag logic"
                  value={filters.logic}
                  onChange={(logic) => setFilters({ ...filters, logic: logic as Filters["logic"] })}
                  options={LOGIC_OPTIONS.tags}
                />
              </div>
              <div className="md:col-span-2">
                <div className="text-xs font-medium text-muted mb-1.5">
                  Show only
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    active={filters.noTags}
                    onClick={() =>
                      setFilters({ ...filters, noTags: !filters.noTags, aiTagged: false })
                    }
                    aria-label={filters.noTags ? "No tags on" : "No tags off"}
                    title="Images with no tags at all"
                  >
                    Untagged
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    active={filters.noAiTags}
                    onClick={() =>
                      setFilters({ ...filters, noAiTags: !filters.noAiTags, aiTagged: false })
                    }
                    aria-label={
                      filters.noAiTags ? "No AI tags on" : "No AI tags off"
                    }
                    title="No AI tags"
                  >
                    No AI
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    active={filters.quarantined}
                    onClick={() =>
                      setFilters({
                        ...filters,
                        quarantined: !filters.quarantined,
                      })
                    }
                    aria-label={
                      filters.quarantined
                        ? "Showing quarantined"
                        : "Show quarantined"
                    }
                    title="Quarantined images"
                  >
                    Quarantined
                  </Button>
                </div>
              </div>
            </div>

            {/* Generation-metadata search */}
            <div className="mt-4 pt-4 border-t border-line space-y-3">
              <h3 className="text-sm font-medium text-neutral-200">
                Generation
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Workflow
                  </label>
                  {/* A family (every version, new ones included) or one
                      version; named as on the Rules page. */}
                  <Picker
                    aria-label="Workflow filter"
                    value={
                      filters.workflow
                        ? `w:${filters.workflow}`
                        : filters.workflowSig
                          ? `s:${filters.workflowSig}`
                          : ""
                    }
                    onChange={(v) =>
                      setFilters({
                        ...filters,
                        workflow: v.startsWith("w:") ? v.slice(2) : undefined,
                        workflowSig: v.startsWith("s:") ? v.slice(2) : undefined,
                      })
                    }
                    options={workflowPickerOptions}
                    searchable
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Model
                  </label>
                  <Picker
                    aria-label="Model filter"
                    value={filters.model || ""}
                    onChange={(model) => setFilters({ ...filters, model: model || undefined })}
                    options={[
                      { value: "", label: "Any model" },
                      ...modelOptions.map((m) => ({ value: m.model, label: m.model, hint: m.count.toLocaleString() })),
                    ]}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    LoRA
                  </label>
                  {/* Adds a search term: several loras can be asked for. */}
                  <Picker
                    aria-label="LoRA filter"
                    value=""
                    placeholder={filters.lora.length ? "Add another LoRA…" : "Add a LoRA…"}
                    onChange={(name) => setFilters({ ...filters, lora: [...filters.lora, name] })}
                    options={loraOptions
                      .filter((l) => !filters.lora.includes(l.name))
                      .map((l) => ({ value: l.name, label: l.name, hint: l.count.toLocaleString() }))}
                    searchable
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Embedding
                  </label>
                  <Picker
                    aria-label="Embedding filter"
                    value=""
                    placeholder={filters.embedding.length ? "Add another embedding…" : "Add an embedding…"}
                    onChange={(name) => setFilters({ ...filters, embedding: [...filters.embedding, name] })}
                    options={embeddingOptions
                      .filter((o) => !filters.embedding.includes(o.name))
                      .map((o) => ({ value: o.name, label: o.name, hint: o.count.toLocaleString() }))}
                    searchable
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Prompt contains
                  </label>
                  <TagSearchInput
                    value={filters.promptTerms}
                    onChange={(promptTerms) =>
                      setFilters({ ...filters, promptTerms })
                    }
                    suggestions={[]}
                    placeholder="Prompt terms…"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Prompt logic
                  </label>
                  <Picker
                    aria-label="Prompt term logic"
                    value={filters.promptLogic}
                    onChange={(promptLogic) =>
                      setFilters({ ...filters, promptLogic: promptLogic as Filters["promptLogic"] })
                    }
                    options={LOGIC_OPTIONS.prompt}
                  />
                </div>
                <SizeFilter filters={filters} setFilters={setFilters} />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilters(withoutFilters(filters))}
              >
                Clear filters
              </Button>
            </div>
          </div>
        )}
      </div>
      </div>

      <div className="px-4 md:px-6 py-4 space-y-3">
      {activeFeed.isLoading && items.length === 0 && (
        <GallerySkeleton density={density.density} />
      )}

      {!activeFeed.isLoading && items.length === 0 && emptyScan && (
        <EmptyState
          icon={FolderSearch}
          title={emptyScan.title}
          description={`${emptyScan.progress}Images show up here as they're found.`}
        />
      )}

      {!activeFeed.isLoading && items.length === 0 && !emptyScan && (
        <EmptyState
          icon={ImageOff}
          title="No images found"
          description={
            !hasActiveFilter(filters)
              ? "You don't have any images yet. Add a library to start importing your images."
              : hasClearableFilter(filters)
                ? filters.tags.length
                  ? "No images match your search with these filters. Clear the filters to search everything."
                  : "No images match your current filters."
                : "No images match your search."
          }
          actions={
            <>
              {/* Filters first, keeping the search; then the search itself. */}
              {hasClearableFilter(filters) ? (
                <Button variant="primary" onClick={() => setFilters(withoutFilters(filters))}>
                  Clear filters
                </Button>
              ) : filters.tags.length > 0 ? (
                <Button
                  variant="primary"
                  onClick={() =>
                    setFilters({ ...filters, tags: [], lora: [], embedding: [], logic: DEFAULT_FILTERS.logic })
                  }
                >
                  Clear search
                </Button>
              ) : null}
              <ButtonLink to="/libraries">Go to Libraries</ButtonLink>
            </>
          }
        />
      )}

      {filters.groupId && (
        <Button
          size="sm"
          onClick={() =>
            setFilters({ ...filters, groupId: undefined, group: true })
          }
        >
          <ArrowLeft size={14} /> Back to batches
        </Button>
      )}

      {items.length > 0 && (
        <div ref={gridWrapRef}>
        <VirtualizedGrid
          items={items}
          selection={selection}
          onToggle={toggleSelection}
          onOpen={onOpenTile}
          getScrollContainer={getScrollContainer}
          selectionMode={selectionMode}
          focusedIndex={focusedIndex}
          density={density.density}
          // In the quarantined view every tile is quarantined, so dimming them
          // all just makes the one screen where you have to look closely to
          // decide on a restore the hardest one to see. The badge carries the
          // meaning there; the dimming is only informative in a mixed feed.
          dimQuarantined={!filters.quarantined}
          restoreScrollTop={restoreScroll}
          peekQuery={peekQuery}
          className="min-h-screen"
        />
        </div>
      )}

      <div ref={sentinelRef} className="h-8" />
      </div>

    </div>
  );
}
