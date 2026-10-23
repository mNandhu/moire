/**
 * View preferences kept on this device (localStorage), every access guarded:
 * with storage blocked (a private window, site data off) a read is "nothing
 * stored" and a write is held in memory for this session instead of throwing.
 * Writes notify subscribers, and another tab's write arrives as a `storage`
 * event, so a hook on the key (hooks/useLocalPref.ts) follows both.
 *
 * The keys in use, saved by users already and so never renamed even where the
 * naming differs (older ones are `area:name`, newer `moire.area.name`):
 *   sidebar:collapsed            App: sidebar rail collapsed ("1"/"0")
 *   gallery:density              useDensity: zoom step, stored once zoomed
 *   gallery_group_pref           useFilters: grouped gallery ("1"/"0")
 *   tags:marks                   useTagMarks: JSON {outlines, tints}
 *   moire.tags.view              TagsPage: "grid" | "list"
 *   imageView:tab                ImageView: "generation" | "tags"
 *   viewer:outfits-open          WornOutfits: panel open ("1"/"0")
 *   moire.generate.boardFolded   PromptBoard: board folded ("1"/"0")
 *   libraries:collapsedFolders   LibrariesPage: JSON array of folder keys
 *   rules:collapsedWorkflows     RulesPage: JSON array of workflow keys
 *   onboarding:shortcut-hint     one-shot flag set by first-run setup
 *   ambient:palette              lib/ambient: last wash palette, JSON array
 */

const memory = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
let watching = false;

function notify(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

export function readLocalPref(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v !== null || !memory.has(key)) return v;
  } catch {
    // Storage off: fall through to what this session wrote.
  }
  return memory.get(key) ?? null;
}

/** Stores `value`; null removes the key. Never throws. */
export function writeLocalPref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    memory.delete(key);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
  notify(key);
}

/** Calls `listener` when `key` changes here or in another tab. */
export function subscribeLocalPref(key: string, listener: () => void): () => void {
  if (!watching && typeof window !== "undefined") {
    watching = true;
    window.addEventListener("storage", (e) => {
      // A null key is storage.clear().
      if (e.key === null) listeners.forEach((_, k) => notify(k));
      else notify(e.key);
    });
  }
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
