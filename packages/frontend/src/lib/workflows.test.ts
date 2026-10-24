import { describe, it, expect } from "vitest";
import type { SignatureRow } from "./rules";
import {
  fileStem,
  formatUsedRange,
  groupWorkflows,
  parseWorkflowFile,
  versionLabel,
  workflowFilterName,
} from "./workflows";

const row = (over: Partial<SignatureRow>): SignatureRow => ({
  workflow_sig: over.workflow_sig ?? "s",
  count: 1,
  needs_mapping: 0,
  sample_image_id: "L:x.png",
  has_ruleset: false,
  node_count: 10,
  distinct: [],
  workflow_id: "W",
  ...over,
});

describe("fileStem", () => {
  it("drops folders and the .json extension", () => {
    expect(fileStem("workflows/RemoteQV2.2.json")).toBe("RemoteQV2.2");
    expect(fileStem("C:\\x\\a.JSON")).toBe("a");
    expect(fileStem("plain")).toBe("plain");
  });
});

describe("parseWorkflowFile", () => {
  it("reads the id and editor node types of a saved workflow", () => {
    const text = JSON.stringify({
      id: "abc",
      nodes: [{ type: "KSampler" }, { type: "" }, { id: 3 }, null],
    });
    expect(parseWorkflowFile(text, "dir/RemoteQ.json")).toEqual({
      workflow_id: "abc",
      filename: "RemoteQ",
      node_types: ["KSampler"],
    });
  });
  it("rejects non-JSON and API-format prompt exports", () => {
    expect(parseWorkflowFile("{", "a.json")).toBeNull();
    expect(parseWorkflowFile(JSON.stringify({ "3": { class_type: "KSampler" } }), "a.json")).toBeNull();
  });
});

describe("versionLabel", () => {
  it("names the starting point and the steps, in pipeline order", () => {
    expect(
      versionLabel({
        node_types: {
          KSampler: 1,
          "Empty Latent Ratio Select SDXL": 1,
          UltimateSDUpscale: 1,
          UpscaleModelLoader: 1,
          LoraLoader: 4,
          FaceDetailer: 1,
          UltralyticsDetectorProvider: 1,
          "Prompts Everywhere": 1,
        },
      }),
    ).toBe("4 LoRAs + Face fix + Upscale");
  });
  it("tells an image-input workflow from a text one", () => {
    expect(versionLabel({ node_types: { LoadImage: 1, UltimateSDUpscale: 1 } })).toBe(
      "From an image + Upscale",
    );
    expect(versionLabel({ node_types: { EmptyLatentImage: 1, KSampler: 1 } })).toBe(
      "Text to image",
    );
    expect(versionLabel({ node_types: { KSampler: 1 } })).toBe("Workflow");
    expect(versionLabel({})).toBe("Workflow");
  });
});

describe("groupWorkflows", () => {
  it("groups by family, orders versions small to large, and keeps titles unique", () => {
    const fams = groupWorkflows([
      row({ workflow_sig: "big", node_count: 20, count: 3, node_types: { EmptyLatentImage: 1, FaceDetailer: 1 } }),
      row({ workflow_sig: "small", node_count: 10, count: 2, node_types: { EmptyLatentImage: 1 } }),
      row({ workflow_sig: "small2", node_count: 11, count: 1, node_types: { EmptyLatentImage: 1 } }),
      row({ workflow_sig: "a1111", workflow_id: null, count: 9 }),
    ]);
    expect(fams.map((f) => [f.id, f.name, f.images])).toEqual([
      ["W", "Unnamed workflow", 6],
      [null, "Other images", 9],
    ]);
    expect(fams[0].versions.map((v) => v.title)).toEqual([
      "Text to image",
      "Text to image (2)",
      "Face fix",
    ]);
  });

  it("prefers the user's name, then the newest matched file; files sit beside titles", () => {
    const [fam] = groupWorkflows([
      row({ workflow_sig: "a", file_name: "RemoteQV2.1", file_match: 0.9 }),
      row({
        workflow_sig: "b",
        node_count: 12,
        file_name: "RemoteQV2.2",
        file_match: 1,
        node_types: { EmptyLatentImage: 1, LoraLoader: 1 },
      }),
    ]);
    expect(fam.name).toBe("RemoteQV2.2");
    expect(fam.unnamed).toBe(true);
    // A different file than the group's name is worth a line...
    expect(fam.versions[0].file).toBe("like RemoteQV2.1");
    // ...the one the group is named after is not.
    expect(fam.versions[1]).toMatchObject({ title: "1 LoRA", file: null });

    const [named] = groupWorkflows([row({ workflow_name: "RemoteQ" })]);
    expect(named).toMatchObject({ name: "RemoteQ", unnamed: false });

    // With a user-given name, every matched file differs from it and shows.
    const [own] = groupWorkflows([
      row({ workflow_name: "Mine", file_name: "RemoteQV2.2", file_match: 0.9 }),
    ]);
    expect(own.versions[0].file).toBe("like RemoteQV2.2");
  });
});

// Local-time epoch seconds for a calendar day (formatting is local too).
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime() / 1000;
const NOW = new Date(2026, 9, 18);

describe("formatUsedRange", () => {
  it.each([
    [day(2026, 10, 3), day(2026, 10, 3), "Oct 3"],
    [day(2026, 10, 3), day(2026, 10, 12), "Oct 3 to 12"],
    [day(2026, 9, 30), day(2026, 12, 7), "Sep 30 to Dec 7"],
    [day(2025, 11, 8), day(2026, 1, 15), "Nov 8, 2025 to Jan 15"],
    [day(2025, 8, 30), day(2025, 9, 30), "Aug 30 to Sep 30, 2025"],
  ])("%s to %s → %s", (a, b, want) => {
    expect(formatUsedRange(a, b, NOW)).toBe(want);
  });
  it("is null without dates", () => {
    expect(formatUsedRange(null, undefined, NOW)).toBeNull();
  });
});

describe("groupWorkflows dates", () => {
  it("orders versions by first use and titles look-alikes by date", () => {
    const [fam] = groupWorkflows(
      [
        row({ workflow_sig: "late", node_types: { EmptyLatentImage: 1 }, first_used: day(2026, 10, 1), last_used: day(2026, 10, 9) }),
        row({ workflow_sig: "early", node_types: { EmptyLatentImage: 1 }, first_used: day(2026, 3, 1), last_used: day(2026, 3, 1) }),
        row({ workflow_sig: "face", node_types: { EmptyLatentImage: 1, FaceDetailer: 1 }, first_used: day(2026, 5, 2), last_used: day(2026, 5, 4) }),
      ],
      NOW,
    );
    expect(fam.versions.map((v) => [v.title, v.note])).toEqual([
      ["Mar 1", "Text to image"],
      ["Face fix", "May 2 to 4"],
      ["Oct 1 to 9", "Text to image"],
    ]);
  });

  it("drops a label every version shares and numbers same-date look-alikes", () => {
    const t = { EmptyLatentImage: 1 };
    const [fam] = groupWorkflows(
      [
        row({ workflow_sig: "a", node_types: t, first_used: day(2026, 2, 13), last_used: day(2026, 3, 1) }),
        row({ workflow_sig: "b", node_types: t, first_used: day(2026, 2, 13), last_used: day(2026, 3, 1) }),
        row({ workflow_sig: "c", node_types: t, first_used: day(2026, 8, 9), last_used: day(2026, 8, 11) }),
      ],
      NOW,
    );
    expect(fam.versions.map((v) => [v.title, v.note])).toEqual([
      ["Feb 13 to Mar 1", null],
      ["Feb 13 to Mar 1 (2)", null],
      ["Aug 9 to 11", null],
    ]);
  });
});

describe("workflowFilterName", () => {
  it("names a family, or a version within it", () => {
    const fams = groupWorkflows([
      row({ workflow_sig: "a", workflow_name: "RemoteQ", node_types: { EmptyLatentImage: 1 } }),
      row({ workflow_sig: "b", node_types: { EmptyLatentImage: 1, FaceDetailer: 1 } }),
      row({ workflow_sig: "solo", workflow_id: "V", workflow_name: "Upscaler" }),
    ]);
    expect(workflowFilterName(fams, { workflow: "W" })).toBe("RemoteQ");
    expect(workflowFilterName(fams, { workflowSig: "b" })).toBe("RemoteQ · Face fix");
    // A one-version family needs no version title.
    expect(workflowFilterName(fams, { workflowSig: "solo" })).toBe("Upscaler");
    expect(workflowFilterName(fams, { workflow: "gone" })).toBeUndefined();
  });
});
