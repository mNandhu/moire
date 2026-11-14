import { describe, it, expect } from "vitest";
import {
  buildLibraryTree,
  countLibraries,
  normalizeLibraryPath,
  pathToLibrary,
  type LibraryTreeNode,
} from "./libraryTree";

type L = { _id: string; path: string };
const lib = (_id: string, path: string): L => ({ _id, path });

/** The tree as nested labels: a library as `=label`, a folder as its label. */
function shape(nodes: LibraryTreeNode<L>[]): unknown[] {
  return nodes.map((n) => {
    const me = n.library ? `=${n.library._id}` : n.label;
    return n.children.length ? [me, shape(n.children)] : me;
  });
}

describe("buildLibraryTree", () => {
  it("leaves unrelated libraries flat", () => {
    const tree = buildLibraryTree([lib("a", "D:/art"), lib("b", "E:/photos")]);
    expect(shape(tree)).toEqual(["=a", "=b"]);
    expect(tree[0].label).toBe("D:/art");
  });

  it("groups subfolders of one parent under it, the shared path on one row", () => {
    const tree = buildLibraryTree([
      lib("a", "D:\\AI\\outputs\\flux"),
      lib("b", "D:/AI/outputs/sdxl/"),
      lib("c", "/home/me/pics"),
    ]);
    expect(shape(tree)).toEqual(["=c", ["D:/AI/outputs", ["=a", "=b"]]]);
    expect(tree[1].children.map((n) => n.label)).toEqual(["flux", "sdxl"]);
    expect(tree[0].label).toBe("/home/me/pics");
  });

  it("nests a library inside another library's folder", () => {
    const tree = buildLibraryTree([lib("in", "D:/AI/x/y"), lib("out", "D:/AI")]);
    expect(shape(tree)).toEqual([["=out", ["=in"]]]);
    expect(tree[0].children[0].label).toBe("x/y");
  });

  it("treats a drive letter's case as one drive", () => {
    const tree = buildLibraryTree([lib("a", "d:/AI/one"), lib("b", "D:/AI/two")]);
    expect(shape(tree)).toEqual([["d:/AI", ["=a", "=b"]]]);
  });

  it("sorts by the shown name, numbers in order", () => {
    const tree = buildLibraryTree(
      [lib("a", "/x/batch10"), lib("b", "/x/batch2")],
      (l) => l.path.split("/").pop()!,
    );
    expect(shape(tree)).toEqual([["/x", ["=b", "=a"]]]);
  });
});

describe("helpers", () => {
  const tree = buildLibraryTree([lib("a", "/r/one"), lib("b", "/r/two/deep"), lib("c", "/r/two/other")]);

  it("counts libraries under a folder", () => {
    expect(countLibraries(tree[0])).toBe(3);
  });

  it("finds the folders on the way to a library", () => {
    expect(pathToLibrary(tree, (l) => l._id === "b")).toEqual(["/r", "/r/two"]);
    expect(pathToLibrary(tree, (l) => l._id === "zzz")).toBeNull();
  });

  it("normalizes slashes and a trailing slash", () => {
    expect(normalizeLibraryPath("C:\\a\\b\\")).toBe("C:/a/b");
    expect(normalizeLibraryPath("/")).toBe("/");
  });
});

it("never drops a library that shares another's folder", () => {
  const tree = buildLibraryTree([lib("a", "D:/a"), lib("b", "D:/a/")]);
  expect(shape(tree)).toEqual([["=a", ["=b"]]]);
});

it("keeps a network share apart from a POSIX folder of the same name", () => {
  const tree = buildLibraryTree([lib("a", "\\\\nas\\pics"), lib("b", "/nas/other")]);
  expect(tree.map((n) => n.label).sort()).toEqual(["//nas/pics", "/nas/other"]);
});

it("keys a folder the same whichever drive spelling came first", () => {
  const a = buildLibraryTree([lib("a", "d:/x/one"), lib("b", "D:/x/two")]);
  const b = buildLibraryTree([lib("b", "D:/x/two"), lib("a", "d:/x/one")]);
  expect(a[0].key).toBe(b[0].key);
});
