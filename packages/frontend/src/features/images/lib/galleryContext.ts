// The gallery's filter as a name for the image view's corner (see
// lib/viewContext). Pure.

import { resourceOf } from "@/features/tags/lib/searchTerms";
import { ANY_PREFIX, formatTag } from "@/features/tags/lib/tags";

/**
 * What the gallery shows, in a line: the library tab it is on, the batch
 * it is drilled into, its search terms (`searchTerms`: tags spelled with spaces, whatever their kind,
 * and `lora:name` and the like as typed), then its filter chips. Undefined for the whole library, which
 * needs no name.
 */
export function galleryContext(
  terms: readonly string[],
  chips: readonly { label: string }[],
  { library, batch = false }: { library?: string; batch?: boolean } = {},
): string | undefined {
  const parts = [
    ...(library ? [library] : []),
    ...(batch ? ["Batch"] : []),
    ...terms.map((t) => (resourceOf(t) ? t : formatTag(t.startsWith(ANY_PREFIX) ? t.slice(ANY_PREFIX.length) : t))),
    ...chips.map((c) => c.label),
  ];
  return parts.length ? parts.join(" · ") : undefined;
}
