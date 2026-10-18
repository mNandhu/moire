import { describe, it, expect } from "vitest";
import { filesFromEntries, type EntryLike } from "./dropFiles";

const file = (name: string): EntryLike => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File(["{}"], name)),
});

// A directory whose reader hands out children in batches of `batch`, then an
// empty batch, like Chromium's readEntries.
const dir = (name: string, children: EntryLike[], batch = 2): EntryLike => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0;
    return {
      readEntries: (ok) => {
        ok(children.slice(i, i + batch));
        i += batch;
      },
    };
  },
});

describe("filesFromEntries", () => {
  it("walks nested folders across reader batches and filters by name", async () => {
    const tree = [
      dir("workflows", [
        file("a.json"),
        file("notes.txt"),
        file("b.json"),
        dir("old", [file("c.json")]),
      ]),
      file("top.json"),
    ];
    const got = await filesFromEntries(tree, (n) => n.endsWith(".json"));
    expect(got.map((f) => f.name)).toEqual(["a.json", "b.json", "c.json", "top.json"]);
  });

  it("returns nothing for an empty folder", async () => {
    expect(await filesFromEntries([dir("empty", [])])).toEqual([]);
  });
});
