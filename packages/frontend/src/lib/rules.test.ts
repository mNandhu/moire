import { describe, it, expect } from "vitest";
import { guessMarks, guessPath, workflowClipboardText, type WorkflowPayload } from "./rules";

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

describe("guessPath / guessMarks", () => {
  const gen = { guessed: ["prompt" as const], guess_paths: { prompt: "prompt.6.inputs.text" } };
  it("gives a guessed field's path, null without one, undefined when not guessed", () => {
    expect(guessPath(gen, "prompt")).toBe("prompt.6.inputs.text");
    expect(guessPath({ guessed: ["negative"] }, "negative")).toBeNull();
    expect(guessPath(gen, "negative")).toBeUndefined();
    expect(guessPath(gen, "seed")).toBeUndefined();
    expect(guessPath(null, "prompt")).toBeUndefined();
  });
  it("marks guessed paths of unpinned prompts only", () => {
    expect([...guessMarks(gen, {})]).toEqual([["prompt.6.inputs.text", "Guessed positive prompt"]]);
    expect(guessMarks(gen, { prompt: ["prompt.3.inputs.text"] }).size).toBe(0);
    expect(guessMarks(null, {}).size).toBe(0);
  });
});
