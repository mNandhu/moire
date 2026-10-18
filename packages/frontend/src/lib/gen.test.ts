import { describe, it, expect } from "vitest";
import {
  signatureTitle,
  workflowClipboardText,
  type SignatureRow,
  type WorkflowPayload,
} from "./gen";

describe("workflowClipboardText", () => {
  it("ComfyUI copies the UI workflow graph (canvas-paste)", () => {
    const p: WorkflowPayload = {
      source: "comfyui",
      workflow: { nodes: [1, 2] },
      prompt: { "3": {} },
    };
    expect(workflowClipboardText(p)).toBe(JSON.stringify({ nodes: [1, 2] }));
  });

  it("ComfyUI falls back to prompt graph when workflow is absent", () => {
    const p = { source: "comfyui", workflow: null, prompt: { "3": {} } } as WorkflowPayload;
    expect(workflowClipboardText(p)).toBe(JSON.stringify({ "3": {} }));
  });

  it("A1111 copies the parameters string", () => {
    const p: WorkflowPayload = { source: "a1111", parameters: "a prompt\nSteps: 20" };
    expect(workflowClipboardText(p)).toBe("a prompt\nSteps: 20");
  });

  it("returns null for unknown/empty source", () => {
    expect(workflowClipboardText({ source: null })).toBeNull();
    expect(workflowClipboardText({ source: "comfyui", workflow: null, prompt: null })).toBeNull();
  });
});

describe("signatureTitle", () => {
  const row = (distinct: SignatureRow["distinct"], node_count = 10): SignatureRow => ({
    workflow_sig: "abc",
    count: 1,
    needs_mapping: 0,
    sample_image_id: "l:x.png",
    has_ruleset: false,
    node_count,
    distinct,
  });
  it("names the distinguishing nodes, with multiplicity and overflow", () => {
    expect(
      signatureTitle(
        row([
          { type: "LoraLoader", count: 2 },
          { type: "FaceDetailer", count: 1 },
          { type: "Upscale", count: 1 },
        ]),
      ),
    ).toBe("LoraLoader ×2, FaceDetailer +1");
  });
  it("calls the workflow with nothing extra the base one", () => {
    expect(signatureTitle(row([]))).toBe("Base workflow");
  });
  it("falls back when the backend sent no summary", () => {
    expect(signatureTitle(row(undefined, 0))).toBe("Workflow");
  });
});
