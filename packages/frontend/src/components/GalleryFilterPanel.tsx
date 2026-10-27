import type { Ref } from "react";
import { X } from "lucide-react";
import { withoutFilters, type FilterChip, type Filters } from "../lib/imageFilter";
import { workflowFromPickerValue, workflowPickerValue } from "../lib/workflowPicker";
import type { FilterOptions } from "../hooks/useFilterOptions";
import { Button } from "./ui/Button";
import { Picker } from "./ui/Picker";
import { SizeFilter } from "./SizeFilter";
import { TagSearchInput } from "./TagSearchInput";

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

/** The active filters as removable chips, shown while the panel is closed. */
export function ActiveFilterChips({
  chips,
  filters,
  setFilters,
}: {
  chips: FilterChip[];
  filters: Filters;
  setFilters: (f: Filters) => void;
}) {
  return (
    <div className="pt-3 pb-3 flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((chip) => (
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
      {chips.length > 1 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFilters(withoutFilters(filters))}
        >
          Clear all
        </Button>
      )}
    </div>
  );
}

/** The gallery's filter panel, folding out beneath the sticky header. */
export function GalleryFilterPanel({
  panelRef,
  filters,
  setFilters,
  options,
  onClearSelection,
}: {
  panelRef: Ref<HTMLDivElement>;
  filters: Filters;
  setFilters: (f: Filters) => void;
  options: Pick<FilterOptions, "workflowPickerOptions" | "modelOptions" | "loraOptions" | "embeddingOptions">;
  onClearSelection: () => void;
}) {
  const { workflowPickerOptions, modelOptions, loraOptions, embeddingOptions } = options;
  return (
    <div
      ref={panelRef}
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
            <Picker
              aria-label="Workflow filter"
              value={workflowPickerValue(filters)}
              onChange={(v) =>
                setFilters({
                  ...filters,
                  ...workflowFromPickerValue(v),
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
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
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
  );
}
