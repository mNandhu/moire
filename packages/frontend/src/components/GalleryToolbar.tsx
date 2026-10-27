import type { Dispatch, Ref, SetStateAction } from "react";
import {
  Check,
  CheckSquare,
  Filter,
  Layers,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tags,
} from "lucide-react";
import type { Filters } from "../lib/imageFilter";
import { searchTerms, withSearchTerms } from "../lib/searchTerms";
import type { FilterOptions } from "../hooks/useFilterOptions";
import { Button } from "./ui/Button";
import { DropdownMenu } from "./ui/DropdownMenu";
import { SortControl, SORT_OPTIONS } from "./SortControl";
import { TagSearchInput } from "./TagSearchInput";

/**
 * The gallery header's control row: filter toggle, search, sort, grouping
 * and selection (folded into one menu on phones), and the selection's actions.
 */
export function GalleryToolbar({
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  filterCount,
  filterButtonRef,
  searchInputRef,
  options,
  grouped,
  onToggleGroup,
  selection,
  selectionMode,
  setSelectionMode,
  selectionActive,
  clearSelection,
  selectAll,
  selectingAll,
  onEditTags,
  runBulkTag,
  runBulkQuarantine,
}: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  filtersOpen: boolean;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  /** Active filter chips, counted on the filter button. */
  filterCount: number;
  filterButtonRef: Ref<HTMLButtonElement>;
  searchInputRef: Ref<HTMLInputElement>;
  options: Pick<FilterOptions, "tagOptions" | "resourceSuggestions" | "knownOutfits" | "knownResources" | "tagNames">;
  grouped: boolean;
  onToggleGroup: () => void;
  selection: Set<string>;
  selectionMode: boolean;
  setSelectionMode: Dispatch<SetStateAction<boolean>>;
  selectionActive: boolean;
  clearSelection: () => void;
  selectAll: () => Promise<void>;
  selectingAll: boolean;
  onEditTags: () => void;
  runBulkTag: (ids: string[]) => Promise<void>;
  runBulkQuarantine: (ids: string[], next: boolean) => Promise<void>;
}) {
  const { tagOptions, resourceSuggestions, knownOutfits, knownResources, tagNames } = options;
  return (
    <div className="flex flex-wrap md:flex-nowrap items-center gap-2">
      <Button
        ref={filterButtonRef}
        size="icon"
        variant="secondary"
        active={filtersOpen || filterCount > 0}
        onClick={() => setFiltersOpen((v) => !v)}
        aria-label={filtersOpen ? "Hide filters" : "Show filters"}
        title={filtersOpen ? "Hide filters" : "Show filters"}
        className="relative"
      >
        <Filter size={18} />
        {filterCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-500 text-white text-2xs font-semibold leading-[18px] tabular-nums">
            {filterCount}
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
              onClick: onToggleGroup,
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
        onClick={onToggleGroup}
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
              onClick: onEditTags,
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
  );
}
