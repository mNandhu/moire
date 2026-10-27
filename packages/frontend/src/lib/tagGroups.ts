/**
 * Tag groups (Danbooru's tag groups: attire, headwear, posture, ...): the
 * group pages at `/tags/groups/:group` list a group's tags. The map comes
 * from `/tags/groups`. Pure.
 */
import type { PickerOption } from "../components/ui/Picker";
import { canonicalName } from "./tags";

export type TagGroups = {
  /** `tag -> group` for the library's tags. */
  tags: Record<string, string>;
  /** `group -> top-level category` (body, attire_and_body_accessories, ...). */
  categories: Record<string, string>;
};

const words = (s: string) => s.replace(/_tags$/, "").replace(/_/g, " ");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `neck_and_neckwear` reads "Neck and neckwear", `eyes_tags` "Eyes". */
export function groupLabel(group: string): string {
  return capital(words(group));
}

/** `attire_and_body_accessories` reads "Attire and body accessories". */
function categoryLabel(category: string): string {
  return capital(words(category));
}

export function groupHref(group: string): string {
  return `/tags/groups/${encodeURIComponent(group)}`;
}

/** The group a tag is in, if any. */
export function groupOf(groups: TagGroups | undefined, tag: string): string | null {
  return groups?.tags[canonicalName(tag).toLowerCase()] ?? null;
}

/** Every group with how many of the library's tags it holds, under its
 * category; categories and groups by name. */
export function groupOptions(groups: TagGroups): PickerOption[] {
  const sizes = new Map<string, number>();
  for (const g of Object.values(groups.tags)) sizes.set(g, (sizes.get(g) ?? 0) + 1);
  return [...sizes]
    .map(([g, n]) => ({ g, n, c: categoryLabel(groups.categories[g] ?? "more") }))
    .sort((a, b) => a.c.localeCompare(b.c) || a.g.localeCompare(b.g))
    .map(({ g, n, c }) => ({
      value: g,
      label: groupLabel(g),
      hint: n.toLocaleString(),
      group: c,
      keywords: g,
    }));
}
