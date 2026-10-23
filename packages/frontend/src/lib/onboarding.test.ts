import { describe, expect, it } from "vitest";
import {
  cleanPath,
  formatDuration,
  isRemote,
  librariesToAdd,
  pathKey,
  planLibrarySync,
  pathProblem,
  sourceProblem,
  sourceTotals,
} from "./onboarding";
import type { DiscoverSource, LibraryCandidate } from "./libraryPlan";

const cand = (path: string, over: Partial<LibraryCandidate> = {}): LibraryCandidate => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  source: path,
  image_count: 10,
  count_capped: false,
  hidden: false,
  status: "new",
  note: null,
  conflict_path: null,
  ...over,
});

const src = (path: string, candidates: LibraryCandidate[], over: Partial<DiscoverSource> = {}): DiscoverSource => ({
  path,
  ok: true,
  error: null,
  subdir_count: 0,
  loose_image_count: 0,
  fell_back_to_root: false,
  candidates,
  ...over,
});

describe("cleanPath", () => {
  it("drops the quotes Copy as path adds", () => {
    expect(cleanPath('  "C:\\ComfyUI\\output"  ')).toBe("C:\\ComfyUI\\output");
    expect(cleanPath("'/srv/images'")).toBe("/srv/images");
  });
  it("leaves unmatched quotes alone", () => {
    expect(cleanPath('"C:\\x')).toBe('"C:\\x');
  });
});

describe("pathProblem", () => {
  it("accepts full paths with either slash", () => {
    for (const p of ["C:\\ComfyUI\\output", "C:/ComfyUI/output", "/mnt/g/images", "\\\\nas\\images"]) {
      expect(pathProblem(p, [])).toBeNull();
    }
  });
  it("rejects relative and drive-relative paths", () => {
    for (const p of ["output", "ComfyUI\\output", "C:", "C:output", "~/images"]) {
      expect(pathProblem(p, [])).toMatch(/full path/);
    }
  });
  it("rejects a folder already listed, whatever its spelling", () => {
    expect(pathProblem("c:/comfyui/output/", ["C:\\ComfyUI\\output"])).toMatch(/already in the list/);
  });
  it("keeps POSIX case", () => {
    expect(pathProblem("/srv/Images", ["/srv/images"])).toBeNull();
  });
  it("rejects folders nested in either direction", () => {
    expect(pathProblem("C:\\ComfyUI\\output\\faces", ["C:\\ComfyUI\\output"])).toMatch(/inside/);
    expect(pathProblem("C:\\ComfyUI", ["C:\\ComfyUI\\output"])).toMatch(/holds/);
  });
  it("doesn't take a shared prefix for nesting", () => {
    expect(pathProblem("C:\\ComfyUI\\output2", ["C:\\ComfyUI\\output"])).toBeNull();
  });
});

describe("pathKey", () => {
  it("keeps a bare root", () => {
    expect(pathKey("/")).toBe("/");
    expect(pathKey("C:\\")).toBe("c:");
  });
});

describe("sourceProblem", () => {
  it("explains an unreachable folder", () => {
    expect(sourceProblem(src("D:\\gone", [], { ok: false, error: "Not a directory or not reachable" }))).toMatch(
      /can't open/,
    );
  });
  it("blocks a folder that is all registered or overlapping", () => {
    expect(sourceProblem(src("/a", [cand("/a", { status: "registered" })]))).toMatch(/already a library/);
    expect(sourceProblem(src("/a", [cand("/a", { status: "overlap", conflict_path: "/" })]))).toMatch(/overlaps/);
  });
  it("lets an empty folder through", () => {
    expect(sourceProblem(src("/a", [cand("/a", { status: "empty", image_count: 0 })]))).toBeNull();
  });
});

describe("librariesToAdd and sourceTotals", () => {
  const s = src("/out", [
    cand("/out/a", { image_count: 5 }),
    cand("/out/b", { status: "empty", image_count: 0 }),
    cand("/out/.cache", { hidden: true }),
    cand("/out/c", { status: "overlap" }),
    cand("/out/d", { image_count: 5000, count_capped: true }),
  ]);
  it("creates new and empty candidates, not hidden or clashing ones", () => {
    expect(librariesToAdd([s]).map((l) => l.path)).toEqual(["/out/a", "/out/b", "/out/d"]);
  });
  it("skips failed sources", () => {
    expect(librariesToAdd([src("/x", [cand("/x")], { ok: false })])).toEqual([]);
  });
  it("totals what will be added", () => {
    expect(sourceTotals(s)).toEqual({ images: 5005, capped: true, libraries: 3 });
  });
});

describe("formatDuration", () => {
  it("uses minutes, then hours", () => {
    expect(formatDuration(10)).toBe("1 min");
    expect(formatDuration(7 * 60)).toBe("7 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    expect(formatDuration(4212 / 0.6)).toBe("1.9 h");
    expect(formatDuration(3 * 3600 + 1200)).toBe("3.3 h");
  });
});

describe("isRemote", () => {
  it("treats loopback as this machine", () => {
    expect(isRemote("localhost")).toBe(false);
    expect(isRemote("127.0.0.1")).toBe(false);
    expect(isRemote("studio-pc.local")).toBe(true);
  });
});

describe("planLibrarySync", () => {
  const w = (path: string) => ({ path, name: path.slice(1) });
  it("adds what is new and leaves what was already created", () => {
    expect(planLibrarySync({ "/a": "id-a" }, [w("/a"), w("/b")])).toEqual({ remove: [], add: [w("/b")] });
  });
  it("removes created libraries that left the list", () => {
    expect(planLibrarySync({ "/a": "id-a", "/b": "id-b" }, [w("/b")])).toEqual({
      remove: [["/a", "id-a"]],
      add: [],
    });
  });
  it("starts from nothing", () => {
    expect(planLibrarySync({}, [w("/a")])).toEqual({ remove: [], add: [w("/a")] });
    expect(planLibrarySync({}, [])).toEqual({ remove: [], add: [] });
  });
});
