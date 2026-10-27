import { describe, it, expect } from "vitest";
import type { SignatureRow } from "./rules";
import type { WorkflowFamily, WorkflowVersion } from "./workflows";
import { workflowFromPickerValue, workflowPickerOptions, workflowPickerValue } from "./workflowPicker";

const version = (sig: string, count: number, title: string, note: string | null = null): WorkflowVersion => ({
  row: { workflow_sig: sig, count } as SignatureRow,
  title,
  note,
  file: null,
});

const fam = (id: string | null, name: string, versions: WorkflowVersion[]): WorkflowFamily => ({
  id,
  name,
  unnamed: false,
  images: versions.reduce((n, v) => n + v.row.count, 0),
  versions,
});

const hint = (n: number, inGen: boolean) => `${n}|${inGen}`;
const never = () => false;

describe("workflowPickerOptions", () => {
  it("starts with Any workflow", () => {
    expect(workflowPickerOptions([], never, hint)).toEqual([{ value: "", label: "Any workflow" }]);
  });

  it("shows a one-version family as the family row alone", () => {
    const opts = workflowPickerOptions([fam("W", "Remote", [version("s1", 4, "Upscale")])], never, hint);
    expect(opts.slice(1)).toEqual([{ value: "w:W", label: "Remote", hint: "4|false", group: "Remote" }]);
  });

  it("lists a multi-version family's versions indented under it", () => {
    const opts = workflowPickerOptions(
      [fam("W", "Remote", [version("s1", 4, "Upscale"), version("s2", 2, "Upscale", "Oct 3")])],
      never,
      hint,
    );
    expect(opts.slice(1)).toEqual([
      { value: "w:W", label: "Remote, all 2 versions", hint: "6|false", group: "Remote" },
      { value: "s:s1", label: "Upscale", hint: "4|false", group: "Remote", indent: true, keywords: "Remote" },
      { value: "s:s2", label: "Upscale · Oct 3", hint: "2|false", group: "Remote", indent: true, keywords: "Remote" },
    ]);
  });

  it("lists an id-less family's versions only, not indented", () => {
    const opts = workflowPickerOptions([fam(null, "Other", [version("s9", 1, "Plain")])], never, hint);
    expect(opts.slice(1)).toEqual([
      { value: "s:s9", label: "Plain", hint: "1|false", group: "Other", indent: false, keywords: "Other" },
    ]);
  });

  it("asks inGenerate by family for family rows and by signature for versions", () => {
    const asked: object[] = [];
    workflowPickerOptions(
      [fam("W", "Remote", [version("s1", 1, "A"), version("s2", 1, "B")])],
      (key) => {
        asked.push(key);
        return "sig" in key && key.sig === "s2";
      },
      hint,
    );
    expect(asked).toEqual([{ family: "W" }, { sig: "s1" }, { sig: "s2" }]);
  });
});

describe("workflowPickerValue / workflowFromPickerValue", () => {
  it("round-trips a family, a version and none", () => {
    expect(workflowPickerValue({ workflow: "W" })).toBe("w:W");
    expect(workflowPickerValue({ workflowSig: "abc" })).toBe("s:abc");
    expect(workflowPickerValue({})).toBe("");
    expect(workflowFromPickerValue("w:W")).toEqual({ workflow: "W", workflowSig: undefined });
    expect(workflowFromPickerValue("s:abc")).toEqual({ workflow: undefined, workflowSig: "abc" });
    expect(workflowFromPickerValue("")).toEqual({ workflow: undefined, workflowSig: undefined });
  });
});
