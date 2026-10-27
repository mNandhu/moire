import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../components/ui";
import { generatorFor } from "../components/generate/InGenerate";
import type { TagSuggestion } from "../components/TagSearchInput";
import type { Filters } from "../lib/imageFilter";
import { useGenerators, useOutfits } from "../lib/generate";
import { imageEmbeddingsQuery, imageLorasQuery, imageModelsQuery, mergedTagsQuery } from "../lib/queries";
import { useSignatures } from "../lib/rules";
import { RESOURCE_PREFIXES } from "../lib/searchTerms";
import { workflowPickerOptions as buildWorkflowPickerOptions } from "../lib/workflowPicker";
import { groupWorkflows } from "../lib/workflows";

// Stable empties so the query defaults don't hand children a new array on
// every render.
const NO_TAGS: TagSuggestion[] = [];
const NO_MODELS: { model: string; count: number }[] = [];
const NO_LORAS: { name: string; count: number }[] = [];

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

/**
 * What the gallery's search box and filter panel offer: known tags, models,
 * loras, embeddings, outfits and workflows.
 */
export function useFilterOptions(filters: Filters, filtersOpen: boolean) {
  // Workflows for the filter picker and the chip's name, grouped as the Rules
  // page groups them. Fetched once the panel opens or a workflow is filtered.
  const { data: signatures } = useSignatures({ enabled: filtersOpen || !!filters.workflow || !!filters.workflowSig });
  const workflowFamilies = useMemo(() => groupWorkflows(signatures ?? []), [signatures]);

  // Known tags (with image counts) powering the search autocomplete.
  // merge_sources collapses the three sources of each tag (AI / manual /
  // prompt) into one cross-source `any:<base>` suggestion so the dropdown
  // shows a single "tag1" row instead of three near-duplicates; the count is
  // distinct images (a tag applied from two sources isn't double-counted).
  // Selecting it matches images tagged from any source (the backend expands
  // `any:`).
  const { data: tagOptions = NO_TAGS } = useQuery(mergedTagsQuery);
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
  const workflowPickerOptions = useMemo(
    () => buildWorkflowPickerOptions(workflowFamilies, (key) => !!generatorFor(generators, key), countHint),
    [workflowFamilies, generators],
  );

  return useMemo(
    () => ({
      workflowFamilies,
    tagOptions,
    modelOptions,
    embeddingOptions,
    loraOptions,
    knownOutfits,
    tagNames,
    resourceSuggestions,
    knownResources,
      workflowPickerOptions,
    }),
    [
      workflowFamilies,
      tagOptions,
      modelOptions,
      embeddingOptions,
      loraOptions,
      knownOutfits,
      tagNames,
      resourceSuggestions,
      knownResources,
      workflowPickerOptions,
    ],
  );
}

export type FilterOptions = ReturnType<typeof useFilterOptions>;
