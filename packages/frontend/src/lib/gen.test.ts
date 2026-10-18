import { describe, it, expect } from "vitest";
import { workflowClipboardText, type WorkflowPayload } from "./gen";

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
