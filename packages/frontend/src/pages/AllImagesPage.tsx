import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { VirtualizedGrid } from "../components/VirtualizedGrid";
import { GallerySkeleton } from "../components/GallerySkeleton";
import { DensityControl } from "../components/DensityControl";
import { openShortcutHelp } from "../lib/shortcuts";
import { useToast } from "../components/Toasts";
import { BulkTagDialog } from "../components/BulkTagDialog";
import { Keyboard, ImageOff, ArrowLeft, FolderSearch } from "lucide-react";
import {
  DEFAULT_FILTERS,
  serializeFilters,
  serializeFiltersForPeek,
  imageHref,
  hasActiveFilter,
  hasClearableFilter,
  withoutFilters,
  type Filters,
  activeFilterChips,
} from "../lib/imageFilter";
import { fetchImageIds } from "../lib/imageApi";
import { PageHeader } from "../components/ui/PageHeader";
import { LibraryScopeTabs } from "../components/LibraryScopeTabs";
import { workflowFilterName } from "../lib/workflows";
import { ambientPalette } from "../lib/blurhash";
import { applyAmbient } from "../lib/ambient";
import { feedNeedsRefetch, useLibraries, useOnLibrariesRead } from "../lib/libraries";
import { Button, ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { ActiveFilterChips, GalleryFilterPanel } from "../components/GalleryFilterPanel";
import { GalleryToolbar } from "../components/GalleryToolbar";
import { useFilters } from "../hooks/useFilters";
import { useFilterOptions } from "../hooks/useFilterOptions";
import { useGalleryShortcuts } from "../hooks/useGalleryShortcuts";
import { useTriage } from "../hooks/useTriage";
import { useBulkActions } from "../hooks/useBulkActions";
import { useSelectionMode } from "../hooks/useSelectionMode";
import { useDensity } from "../hooks/useDensity";
import {
  useImageFeed,
  useImageGroups,
} from "../hooks/useImageFeed";
import { useScrollRestoration } from "../hooks/useScrollRestoration";
import { PAGE_LIMIT } from "../lib/imageFilter";
import { FETCH_AHEAD_PX } from "../lib/masonryLayout";
import { errorText } from "../lib/api";
import { useDismiss } from "../hooks/useDismiss";
import { withBackgroundLocation } from "../lib/backgroundLocation";

/** `f` without its library scope (a tab, not a filter). */
const withoutLibrary = (f: Filters): Filters => ({ ...f, libraryId: undefined });

export default function AllImagesPage() {
  const { push } = useToast();
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
  // Slow idle poll, brisk while a scan runs: catches scans and watcher events
  // started elsewhere while the gallery stays open.
  const libsQuery = useLibraries({ idleMs: 8000 });
  const libs = useMemo(() => libsQuery.data ?? [], [libsQuery.data]);
  const filterOptions = useFilterOptions(filters, filtersOpen);
  const { workflowFamilies } = filterOptions;

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
      const got = await fetchImageIds(filters);
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
  // The column count the grid packed, as it reports it: arrow-key row jumps
  // step by exactly that.
  const gridColsRef = useRef(1);
  const onGridColumns = useCallback((cols: number) => {
    gridColsRef.current = cols;
  }, []);
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
  // a library is added/rescanned/changed on disk. While a scan runs, and when
  // the watcher reports an event (neither shows in the activity poll), this
  // page refetches the feed from reads of the library list (useLibraries
  // above), so images appear as they arrive. The refresh after a scan ends is
  // app-wide (useRefreshOnFinish). See feedNeedsRefetch.
  // The visible one: the grouped view when grouping, else the flat feed.
  const refetchFeedRef = useRef(activeFeed.refetch);
  refetchFeedRef.current = activeFeed.refetch;
  useOnLibrariesRead(libsQuery, (prev, next) => {
    if (feedNeedsRefetch(prev, next)) refetchFeedRef.current();
  });

  // Close filters on outside click / ESC.
  useDismiss([filtersPanelRef, filterButtonRef], () => setFiltersOpen(false), filtersOpen);

  useGalleryShortcuts({
    filters,
    setFilters,
    density,
    searchInputRef,
    selectionMode,
    setSelectionMode,
    setFocusedIndex,
  });

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
      navigate(imageHref(id, filters), {
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
  useTriage({
    items,
    focusedIndex,
    setFocusedIndex,
    enabled: triageEnabled,
    quarantined: filters.quarantined,
    gridColsRef,
    getScrollContainer,
    openTile,
    refetchFeed: feed.refetch,
  });

  // --- Bulk actions ----------------------------------------------------------
  const { runBulkQuarantine, runBulkTag, runBulkManualTags, bulkTagOpen, setBulkTagOpen } = useBulkActions({
    selection,
    setSelectionMode,
  });

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
        <GalleryToolbar
          filters={filters}
          setFilters={setFilters}
          filtersOpen={filtersOpen}
          setFiltersOpen={setFiltersOpen}
          filterCount={filterChips.length}
          filterButtonRef={filterButtonRef}
          searchInputRef={searchInputRef}
          options={filterOptions}
          grouped={grouped}
          onToggleGroup={toggleGroup}
          selection={selection}
          selectionMode={selectionMode}
          setSelectionMode={setSelectionMode}
          selectionActive={selectionActive}
          clearSelection={clearSelection}
          selectAll={selectAll}
          selectingAll={selectingAll}
          onEditTags={() => setBulkTagOpen(true)}
          runBulkTag={runBulkTag}
          runBulkQuarantine={runBulkQuarantine}
        />

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
          <ActiveFilterChips chips={filterChips} filters={filters} setFilters={setFilters} />
        )}

        {filtersOpen && (
          <GalleryFilterPanel
            panelRef={filtersPanelRef}
            filters={filters}
            setFilters={setFilters}
            options={filterOptions}
            onClearSelection={clearSelection}
          />
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
          onColumns={onGridColumns}
          className="min-h-screen"
        />
      )}

      <div ref={sentinelRef} className="h-8" />
      </div>

    </div>
  );
}
