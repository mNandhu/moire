import { useMemo, useState, type ReactNode } from "react";

// Does a key or any descendant value contain the (lowercased) search term?
// Drives both the highlight and the auto-expand: a node matches when its own key
// matches (e.g. node id "34"), or any nested value does (a class_type like
// "CLIPTextEncode", a prompt word like "masterpiece"). Exported for unit testing.
export function matchesQuery(
  value: unknown,
  query: string,
  key?: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (key !== undefined && key.toLowerCase().includes(q)) return true;
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return String(value).toLowerCase().includes(q);
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.some(([k, v]) => matchesQuery(v, q, k));
}

// Flatten every leaf whose key or value contains the term into pinnable rows,
// so matches can be surfaced at the top of the panel (no scrolling to find the
// buried node). Each row carries its rooted dot-path, the same path clicking the
// tree leaf would pin. Exported for unit testing.
export type GraphMatch = { path: string; value: unknown };

export function collectMatches(
  value: unknown,
  query: string,
  path = "",
  key = "",
): GraphMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  if (value === null || typeof value !== "object") {
    const keyHit = key.toLowerCase().includes(q);
    const valHit = value != null && String(value).toLowerCase().includes(q);
    return keyHit || valHit ? [{ path, value }] : [];
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return entries.flatMap(([k, v]) =>
    collectMatches(v, q, path ? `${path}.${k}` : k, k),
  );
}

const childEntries = (value: object) =>
  Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);

// The paths of the branches under `value` that a search or a mark holds open,
// found in one walk of the tree (a branch is open when its key or anything in
// it matches, or a mark sits below it). Paths are rooted at `path`.
export function forcedBranches(
  value: unknown,
  path: string,
  query: string,
  marks?: ReadonlyMap<string, string>,
): Set<string> {
  const q = query.trim().toLowerCase();
  const marked = new Set<string>();
  for (const m of marks?.keys() ?? []) {
    for (let i = m.indexOf("."); i >= 0; i = m.indexOf(".", i + 1)) marked.add(m.slice(0, i));
  }
  const out = new Set<string>();
  // Whether the node's key or anything inside it matches the search.
  const walk = (v: unknown, key: string, at: string): boolean => {
    let hit = !!q && key.toLowerCase().includes(q);
    if (v && typeof v === "object") {
      for (const [k, c] of childEntries(v)) {
        if (walk(c, k, at ? `${at}.${k}` : k)) hit = true;
      }
      if (hit || marked.has(at)) out.add(at);
    } else if (q && v != null && String(v).toLowerCase().includes(q)) {
      hit = true;
    }
    return hit;
  };
  if (value && typeof value === "object") {
    for (const [k, c] of childEntries(value)) walk(c, k, path ? `${path}.${k}` : k);
  }
  return out;
}

const HIT = "bg-yellow-500/25 text-yellow-100 rounded px-0.5";

// A clickable JSON tree: leaves pin their dot-path into the active field.
// `query` highlights matching keys/values and force-opens the branches that
// contain a match (the tree is collapsed at depth >= 2), so a search reveals the
// whole matching node: its id *and* its class_type stay in view, never pruned.
// `marks` labels leaves by path (where the prompt was guessed from) and keeps
// the branches down to them open, so they're visible without searching.
// Exported for unit testing the path construction (the load-bearing, silent-on-
// failure interaction: click leaf -> correct dot-path).
export function JsonTree({
  value,
  path,
  onPin,
  depth = 0,
  query = "",
  marks,
  forcedSet,
}: {
  value: unknown;
  path: string;
  onPin: (path: string) => void;
  depth?: number;
  query?: string;
  marks?: ReadonlyMap<string, string>;
  /** Internal: the root works out which branches are held open, once. */
  forcedSet?: ReadonlySet<string>;
}) {
  const rootForced = useMemo(
    () => (forcedSet ? null : forcedBranches(value, path, query, marks)),
    [forcedSet, value, path, query, marks],
  );
  const forcedIn = forcedSet ?? rootForced!;
  const isObj = value && typeof value === "object";
  const hasQuery = query.trim().length > 0;

  if (!isObj) {
    const valHit = hasQuery && matchesQuery(value, query);
    const mark = marks?.get(path);
    return (
      <button
        onClick={() => onPin(path)}
        data-graph-path={path}
        className={`group inline-flex items-baseline gap-2 text-left hover:bg-brand-500/10 rounded px-1 -mx-1 w-full ${
          mark ? "ring-1 ring-amber-400/40" : ""
        }`}
        title={`Pin ${path}`}
      >
        <span className={valHit ? `break-all ${HIT}` : "text-emerald-300 break-all"}>
          {JSON.stringify(value)}
        </span>
        {mark && (
          <span className="shrink-0 text-2xs font-sans px-1.5 rounded-md border border-amber-400/30 text-amber-300">
            {mark}
          </span>
        )}
        <span className="text-2xs text-faint group-hover:text-brand-300 ml-auto shrink-0">
          {path}
        </span>
      </button>
    );
  }

  const entries = childEntries(value);

  return (
    <div className={depth === 0 ? "" : "pl-3 border-l border-neutral-800"}>
      {entries.map(([k, v]) => {
        const childPath = path ? `${path}.${k}` : k;
        const leaf = !v || typeof v !== "object";
        const keyHit = hasQuery && k.toLowerCase().includes(query.trim().toLowerCase());
        const keyCls = keyHit ? HIT : "text-sky-300";
        // Force a branch open when it (or a descendant) matches the search.
        const forced = forcedIn.has(childPath);
        return (
          <div key={k} className="py-0.5">
            {leaf ? (
              <div className="flex items-baseline gap-2">
                <span className={`shrink-0 ${keyCls}`}>{k}:</span>
                <JsonTree
                  value={v}
                  path={childPath}
                  onPin={onPin}
                  depth={depth + 1}
                  query={query}
                  marks={marks}
                  forcedSet={forcedIn}
                />
              </div>
            ) : (
              <Branch name={k} keyCls={keyCls} forced={forced} initiallyOpen={depth < 2}>
                <JsonTree
                  value={v}
                  path={childPath}
                  onPin={onPin}
                  depth={depth + 1}
                  query={query}
                  marks={marks}
                  forcedSet={forcedIn}
                />
              </Branch>
            )}
          </div>
        );
      })}
    </div>
  );
}

// One expandable node. It owns its toggle, so opening a branch never moves
// its siblings.
function Branch({
  name,
  keyCls,
  forced,
  initiallyOpen,
  children,
}: {
  name: string;
  keyCls: string;
  forced: boolean;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  // null until clicked: open by depth, or while the search or a mark needs it.
  const [choice, setChoice] = useState<boolean | null>(null);
  const shown = choice ?? (initiallyOpen || forced);
  return (
    <div>
      <button
        onClick={() => setChoice(!shown)}
        className={`hover:text-sky-200 ${keyCls}`}
      >
        {shown ? "▾" : "▸"} {name}
      </button>
      {shown && children}
    </div>
  );
}
