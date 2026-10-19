import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { VirtualizedGrid } from "../components/VirtualizedGrid";
import { GallerySkeleton } from "../components/GallerySkeleton";
import { DensityControl } from "../components/DensityControl";
import { ShortcutOverlay } from "../components/ShortcutOverlay";
import { useToast } from "../components/Toasts";
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
} from "lucide-react";
import {
  DEFAULT_FILTERS,
  serializeFilters,
  serializeFiltersForPeek,
  hasActiveFilter,
  type Filters,
  activeFilterChips,
} from "../lib/imageFilter";
import { PageHeader } from "../components/ui/PageHeader";
import { LibraryScopeTabs } from "../components/LibraryScopeTabs";
import { SortControl } from "../components/SortControl";
import { fetchSignatures } from "../lib/gen";
import { groupWorkflows, workflowFilterName } from "../lib/workflows";
import { ambientPalette } from "../lib/blurhash";
import { applyAmbient } from "../lib/ambient";
import { LIBRARIES_KEY, TAGS_KEY, type Library } from "../lib/queries";
import { Button, ButtonLink } from "../components/ui/Button";
import { DropdownMenu } from "../components/ui/DropdownMenu";
import { Input, Select } from "../components/ui/Input";
import { EmptyState } from "../components/ui/EmptyState";
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
import { type ImageDoc } from "../lib/imageFilter";
import { nextFocusIndex, isGridNavKey } from "../lib/gridNav";
import { gridColumns } from "../lib/masonryLayout";
import { runBulk } from "../lib/bulk";
import {
  setScore as apiSetScore,
  setQuarantine as apiSetQuarantine,
  bulkManualTags,
} from "../lib/imageMutations";
import { api } from "../lib/api";
import { isFormField } from "../lib/dom";
import { useOverlayOpen, withBackgroundLocation } from "../lib/backgroundLocation";
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

export default function AllImagesPage() {
  const { push } = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const location = useLocation();
  // ImageView opens as an overlay on top of this page rather than routing in
  // place of it (see RootRoutes), so this page never unmounts while it's
  // open, its global key listeners below must bail instead, or they'd keep
  // acting on the backgrounded grid while ImageView is also handling keys.
  const overlayOpen = useOverlayOpen();

  // Image filter (URL is the single source of truth) and the Image feed it drives.
  const [filters, setFilters] = useFilters();
  const feed = useImageFeed(filters);
  // Grouped (batch-collapsed) view: active only when collapsing AND not drilled
  // into a specific batch. Drilling in (groupId) shows that batch ungrouped.
  const groupMode = filters.group && !filters.groupId;
  const groups = useImageGroups(filters, groupMode);
  const activeFeed = groupMode ? groups : feed;
  const items = activeFeed.items;

  // Tint the app with the strongest hues among the first images in the feed.
  useEffect(() => {
    applyAmbient(ambientPalette(items.slice(0, 24).map((it) => it.blurhash)));
  }, [items]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const queryClient = useQueryClient();
  // Seeded from the shared cache so a return visit has names immediately;
  // the poll below keeps both this and the cache current.
  const [libs, setLibs] = useState<Library[]>(
    () => queryClient.getQueryData<Library[]>(LIBRARIES_KEY) ?? [],
  );
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
  const { data: modelOptions = NO_MODELS } = useQuery({
    queryKey: ["image-models"],
    queryFn: ({ signal }) =>
      api<{ model: string; count: number }[]>(`/api/v1/images/models`, { signal }),
  });
  // Distinct loras (with counts) for the LoRA filter dropdown.
  const { data: loraOptions = NO_LORAS } = useQuery({
    queryKey: ["image-loras"],
    queryFn: ({ signal }) =>
      api<{ name: string; count: number }[]>(`/api/v1/images/loras`, { signal }),
  });
  const {
    selection,
    selectionMode,
    setSelectionMode,
    selectionActive,
    toggle: toggleSelection,
    clear: clearSelection,
  } = useSelectionMode();
  const density = useDensity();
  const [showShortcuts, setShowShortcuts] = useState(false);

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

  // Scroll restoration keyed by the active filter. The hook only saves and
  // hands back the offset; the grid applies it, because only the grid knows
  // when it has packed a height to scroll within.
  const { save: saveScroll, restore: restoreScroll } = useScrollRestoration(
    serializeFilters(filters).toString(),
    getScrollContainer,
  );

  // Load libraries for the filter dropdown, and keep them polled while any
  // library is scanning OR the filesystem watcher reports new activity.
  // Indexing runs as an async background scan/watcher, so images land after
  // a library is added/rescanned/changed on disk. The scan-progress poll that
  // triggers a feed refresh lives on the Libraries page, which is unmounted
  // once the user is here, so the gallery must watch scan/watch state itself
  // and refetch the feed as images arrive, instead of needing a full reload.
  const refetchFeedRef = useRef(feed.refetch);
  refetchFeedRef.current = feed.refetch;
  // Seed true so the first poll tick always does one fresh pull on mount;
  // covers a scan that finishes in the race window between the feed's
  // mount-refetch and tick 1, and sidesteps the 30s stale-cache window.
  const wasScanningRef = useRef(true);
  // Per-library `last_event_at` last seen, so a watcher-driven add/modify/
  // delete between ticks (no `scanning` flag involved) still triggers a
  // refetch instead of silently landing only on the next manual reload.
  const lastEventSeenRef = useRef<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      let anyScanning = false;
      try {
        const data = await api<Library[]>(`/api/v1/libraries`);
        if (cancelled) return;
        setLibs(data);
        queryClient.setQueryData(LIBRARIES_KEY, data);
        anyScanning = data.some((l) => l.scanning);
        const seen = lastEventSeenRef.current;
        let watcherActivity = false;
        for (const l of data) {
          if (l.last_event_at && l.last_event_at !== seen[l._id]) {
            watcherActivity = true;
            seen[l._id] = l.last_event_at;
          }
        }
        // Refetch while a scan runs AND once more on the scanning -> done
        // transition. The trailing pull matters: cursor pages are keyed by
        // ascending _id and the scan appends higher _ids, so the final batch
        // (and a page-1 that was still short mid-scan, which left hasNextPage
        // false and killed paging) is only picked up by refetching after the
        // scan finishes. Refetch re-derives getNextPageParam, reviving paging.
        // Watcher activity gets the same treatment: a single ingested file is
        // a small feed delta, but it still needs a refetch to appear.
        if (anyScanning || wasScanningRef.current || watcherActivity) {
          refetchFeedRef.current();
        }
        wasScanningRef.current = anyScanning;
      } catch {
        // Ignore transient errors; retry on the next tick.
      }
      if (!cancelled) {
        // Poll briskly during a scan, lazily otherwise to catch scans/watcher
        // events that start from another page while the gallery stays open.
        timer = setTimeout(tick, anyScanning ? 1500 : 8000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);

  // Close filters on outside click / ESC.
  useEffect(() => {
    if (!filtersOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (filtersPanelRef.current?.contains(target)) return;
      if (filterButtonRef.current?.contains(target)) return;
      setFiltersOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filtersOpen]);

  // Global shortcuts: S selection mode, F/"/" focus search, N no-tags,
  // A no-AI-tags, Q quarantined, +/- zoom, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isFormField(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }
      if (e.key === "Escape" && showShortcuts) {
        setShowShortcuts(false);
        return;
      }
      // Everything past here mutates state the help overlay is covering. The
      // triage handler already bailed on `showShortcuts`; this one did not, so
      // reading "Q: quarantined" in the overlay and pressing Q switched the
      // feed underneath it, invisibly.
      if (showShortcuts) return;

      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        density.zoomIn();
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        density.zoomOut();
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (e.key === "Escape") {
        // One key backs out of whatever is engaged, outermost first. The
        // overlay is handled above, before the bail.
        if (selectionMode) setSelectionMode(false);
        else setFocusedIndex(-1);
        return;
      }

      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        setSelectionMode((v) => {
          const next = !v;
          push(next ? "Selection mode ON" : "Selection mode OFF", "info");
          return next;
        });
      } else if (k === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (k === "n") {
        e.preventDefault();
        const next = !filters.noTags;
        push(next ? "No-tags filter ON" : "No-tags filter OFF", "info");
        setFilters({ ...filters, noTags: next });
      } else if (k === "a") {
        e.preventDefault();
        const next = !filters.noAiTags;
        push(next ? "No-AI-tags filter ON" : "No-AI-tags filter OFF", "info");
        setFilters({ ...filters, noAiTags: next });
      } else if (k === "q") {
        e.preventDefault();
        const next = !filters.quarantined;
        push(next ? "Showing quarantined" : "Showing active feed", "info");
        setFilters({ ...filters, quarantined: next });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    push,
    filters,
    setFilters,
    density,
    selectionMode,
    setSelectionMode,
    showShortcuts,
    overlayOpen,
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


  // Infinite scroll: fetch the next page (feed or grouped view) on sentinel view.
  useEffect(() => {
    if (!activeFeed.hasNextPage || activeFeed.isFetchingNextPage) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) activeFeed.fetchNextPage();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [
    activeFeed.hasNextPage,
    activeFeed.isFetchingNextPage,
    activeFeed.fetchNextPage,
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

  // --- Keyboard triage on the focused tile -----------------------------------
  const triageEnabled = !selectionMode && !groupMode && !showShortcuts;

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
        push(`Failed to set score: ${String(e)}`, "error");
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
      push(`Failed: ${String(e)}`, "error");
      feed.refetch();
    }
  }, [items, focusedIndex, filters.quarantined, patchFeed, push, feed]);

  useEffect(() => {
    if (!triageEnabled) {
      setFocusedIndex(-1);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (overlayOpen) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isFormField(e.target)) return;
      if (isGridNavKey(e.key)) {
        e.preventDefault();
        const key = e.key; // narrowed to GridNavKey before the closure
        const cols = gridColumns(
          gridWrapRef.current?.clientWidth || 0,
          density.density,
        );
        setFocusedIndex((prev) => nextFocusIndex(prev, key, cols, items.length));
      } else if (e.key >= "0" && e.key <= "5") {
        if (focusedIndex >= 0) {
          e.preventDefault();
          void triageScore(Number(e.key));
        }
      } else if (e.key === "x" || e.key === "X" || e.key === "Delete") {
        if (focusedIndex >= 0) {
          e.preventDefault();
          void triageQuarantine();
        }
      } else if (e.key === "Enter") {
        // The tile that receives focus is ThumbnailTile's wrapper <div
        // tabIndex={-1}>, not the inner <button>, so there is no default
        // activation to fall back on, arrowing to a tile and pressing Enter
        // did nothing at all.
        if (focusedIndex >= 0) {
          const it = items[focusedIndex];
          if (it) {
            e.preventDefault();
            openTile(it._id);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    triageEnabled,
    items,
    focusedIndex,
    triageScore,
    triageQuarantine,
    openTile,
    density.density,
    overlayOpen,
  ]);

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
        push(`Failed to start AI job: ${String(e)}`, "error");
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
        push(`Failed to update tags: ${String(e)}`, "error");
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
              onClick={() => setShowShortcuts(true)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
            >
              <Keyboard size={18} />
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2">
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
              value={filters.tags}
              onChange={(tags) => setFilters({ ...filters, tags })}
              suggestions={tagOptions}
              placeholder="Search tags…"
            />
          </div>
          <SortControl
            value={filters.sort}
            onChange={(sort) => setFilters({ ...filters, sort })}
          />
          <Button
            size="icon"
            variant="secondary"
            active={filters.group && !filters.groupId}
            onClick={() =>
              setFilters({
                ...filters,
                group: !filters.group,
                groupId: undefined,
              })
            }
            aria-label={filters.group ? "Ungroup batches" : "Group batches"}
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
          {selectionMode && selectionActive && (
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
          <div className="pb-3 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
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
                onClick={() =>
                  setFilters({
                    ...DEFAULT_FILTERS,
                    tags: filters.tags,
                    logic: filters.logic,
                    libraryId: filters.libraryId,
                    sort: filters.sort,
                    group: filters.group,
                    groupId: filters.groupId,
                  })
                }
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
                <Select
                  aria-label="Tag logic"
                  value={filters.logic}
                  onChange={(e) =>
                    setFilters({
                      ...filters,
                      logic: e.target.value as Filters["logic"],
                    })
                  }
                >
                  <option value="and">Match all tags (AND)</option>
                  <option value="or">Match any tag (OR)</option>
                </Select>
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
                      setFilters({ ...filters, noTags: !filters.noTags })
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
                      setFilters({ ...filters, noAiTags: !filters.noAiTags })
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
                  <Select
                    aria-label="Workflow filter"
                    value={
                      filters.workflow
                        ? `w:${filters.workflow}`
                        : filters.workflowSig
                          ? `s:${filters.workflowSig}`
                          : ""
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      setFilters({
                        ...filters,
                        workflow: v.startsWith("w:") ? v.slice(2) : undefined,
                        workflowSig: v.startsWith("s:") ? v.slice(2) : undefined,
                      });
                    }}
                  >
                    <option value="">Any workflow</option>
                    {workflowFamilies.map((fam) => (
                      <optgroup key={fam.id ?? "other"} label={fam.name}>
                        {fam.id && (
                          <option value={`w:${fam.id}`}>
                            {fam.versions.length > 1
                              ? `${fam.name}, all ${fam.versions.length} versions · ${fam.images}`
                              : `${fam.name} · ${fam.images}`}
                          </option>
                        )}
                        {(fam.versions.length > 1 || !fam.id) &&
                          fam.versions.map((v) => (
                            <option key={v.row.workflow_sig} value={`s:${v.row.workflow_sig}`}>
                              {"\u00a0\u00a0"}
                              {v.title}
                              {v.note ? ` · ${v.note}` : ""} · {v.row.count}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Model
                  </label>
                  <Select
                    aria-label="Model filter"
                    value={filters.model || ""}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        model: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Any model</option>
                    {modelOptions.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.model} ({m.count})
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    LoRA
                  </label>
                  <Select
                    aria-label="LoRA filter"
                    value={filters.lora || ""}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        lora: e.target.value || undefined,
                      })
                    }
                  >
                    <option value="">Any LoRA</option>
                    {loraOptions.map((l) => (
                      <option key={l.name} value={l.name}>
                        {l.name} ({l.count})
                      </option>
                    ))}
                  </Select>
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
                  <Select
                    aria-label="Prompt term logic"
                    value={filters.promptLogic}
                    onChange={(e) =>
                      setFilters({
                        ...filters,
                        promptLogic: e.target.value as Filters["promptLogic"],
                      })
                    }
                  >
                    <option value="and">Match all terms (AND)</option>
                    <option value="or">Match any term (OR)</option>
                  </Select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Width (min / max)
                  </label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      aria-label="Min width"
                      placeholder="min"
                      value={filters.minW ?? ""}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          minW: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                    <Input
                      type="number"
                      aria-label="Max width"
                      placeholder="max"
                      value={filters.maxW ?? ""}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          maxW: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1.5">
                    Height (min / max)
                  </label>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      aria-label="Min height"
                      placeholder="min"
                      value={filters.minH ?? ""}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          minH: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                    <Input
                      type="number"
                      aria-label="Max height"
                      placeholder="max"
                      value={filters.maxH ?? ""}
                      onChange={(e) =>
                        setFilters({
                          ...filters,
                          maxH: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
              <Button
                size="sm"
                variant="ghost"
                // Scope (library tab) and order aren't filters; keep them.
                onClick={() =>
                  setFilters({
                    ...DEFAULT_FILTERS,
                    libraryId: filters.libraryId,
                    sort: filters.sort,
                  })
                }
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

      {!activeFeed.isLoading && items.length === 0 && (
        <EmptyState
          icon={ImageOff}
          title="No images found"
          description={
            hasActiveFilter(filters)
              ? "No images match your current filters. Try adjusting your search criteria."
              : "You don't have any images yet. Add a library to start importing your images."
          }
          actions={
            <>
              {hasActiveFilter(filters) && (
                <Button
                  variant="primary"
                  // Out of an empty result entirely (library too), but keep
                  // the order the viewer chose.
                  onClick={() => setFilters({ ...DEFAULT_FILTERS, sort: filters.sort })}
                >
                  Clear filters
                </Button>
              )}
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
          onOpen={openTile}
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

      {showShortcuts && (
        <ShortcutOverlay onClose={() => setShowShortcuts(false)} />
      )}
    </div>
  );
}
