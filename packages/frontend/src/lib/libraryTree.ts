/**
 * Libraries as a folder tree: libraries under a common folder group under
 * it, so the libraries made from one parent's subfolders sit together.
 * Folders with nothing to tell apart fold into one row (`D:/AI/outputs`
 * rather than three nested rows). Pure.
 */

export type LibraryTreeNode<L> = {
  /** The folder's full path, `/`-separated: a stable key. */
  key: string;
  /** What the row shows: the path below its parent row. */
  label: string;
  /** The library at this folder, if there is one. */
  library?: L;
  children: LibraryTreeNode<L>[];
};

/** `D:\images\` and `D:/images` are one folder. */
export function normalizeLibraryPath(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The folders of a path, top first. A POSIX root is a leading "/"; a
 * network share (`//nas/pics`) starts at its server. */
function segments(path: string): string[] {
  const p = normalizeLibraryPath(path);
  const parts = p.split("/").filter(Boolean);
  if (p.startsWith("//") && parts.length) return [`//${parts[0]}`, ...parts.slice(1)];
  return p.startsWith("/") ? ["/", ...parts] : parts;
}

function join(parent: string, seg: string): string {
  if (!parent) return seg;
  return parent.endsWith("/") ? parent + seg : `${parent}/${seg}`;
}

type Raw<L> = { seg: string; key: string; library?: L; kids: Map<string, Raw<L>> };

/** Every library's folder, nested; libraries a folder holds sit under it.
 * Rows sort by `name` (a library's shown name), else by their label. */
export function buildLibraryTree<L extends { path: string }>(
  libraries: readonly L[],
  name?: (l: L) => string,
): LibraryTreeNode<L>[] {
  const root: Raw<L> = { seg: "", key: "", kids: new Map() };
  for (const lib of libraries) {
    let node = root;
    for (const seg of segments(lib.path)) {
      // A drive letter's case doesn't matter (`d:` is `D:`).
      const id = /^[a-z]:$/i.test(seg) ? seg.toUpperCase() : seg;
      let next = node.kids.get(id);
      if (!next) {
        // Keyed by the one spelling, so a saved collapsed folder stays put.
        next = { seg, key: join(node.key, id), kids: new Map() };
        node.kids.set(id, next);
      }
      node = next;
    }
    // The backend refuses a second library on one folder, but an old
    // spelling (`D:/a/` beside `D:/a`) can slip by: show both, never drop one.
    if (node.library) {
      const key = `${node.key}#${node.kids.size}`;
      node.kids.set(key, { seg: node.seg, key, library: lib, kids: new Map() });
    } else node.library = lib;
  }

  const label = (n: LibraryTreeNode<L>) => (n.library && name ? name(n.library) : n.label);
  const fold = (raw: Raw<L>, prefix: string): LibraryTreeNode<L>[] => {
    const here = prefix ? join(prefix, raw.seg) : raw.seg;
    const kids = [...raw.kids.values()];
    // A folder with no library and one subfolder is only part of a path.
    if (!raw.library && kids.length === 1) return fold(kids[0], here);
    const children = kids
      .flatMap((k) => fold(k, ""))
      .sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
    return [{ key: raw.key, label: here, library: raw.library, children }];
  };
  const top = [...root.kids.values()].flatMap((k) => fold(k, ""));
  return top.sort((a, b) => label(a).localeCompare(label(b), undefined, { numeric: true }));
}

/** Every library a node holds, itself included, outermost first. */
export function librariesUnder<L>(node: LibraryTreeNode<L>): L[] {
  return [...(node.library ? [node.library] : []), ...node.children.flatMap(librariesUnder)];
}

/** How many libraries a node holds, itself included. */
export function countLibraries<L>(node: LibraryTreeNode<L>): number {
  return librariesUnder(node).length;
}

/** The keys of the folders on the way to `match`'s library, outermost first. */
export function pathToLibrary<L>(
  nodes: readonly LibraryTreeNode<L>[],
  match: (l: L) => boolean,
): string[] | null {
  for (const n of nodes) {
    if (n.library && match(n.library)) return [];
    const below = pathToLibrary(n.children, match);
    if (below) return [n.key, ...below];
  }
  return null;
}
