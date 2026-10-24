import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRulesetSession } from "./useRulesetSession";
import type { SignatureRow } from "../lib/rules";

const gen = vi.hoisted(() => ({
  fetchRuleset: vi.fn(),
  fetchWorkflow: vi.fn(),
  saveRuleset: vi.fn(),
  deleteRuleset: vi.fn(),
}));

vi.mock("../lib/rules", async (orig) => ({
  ...(await orig<typeof import("../lib/rules")>()),
  ...gen,
}));

const SIG_A = {
  workflow_sig: "sigA",
  sample_image_id: "L1:a.png",
} as SignatureRow;
const SIG_B = {
  workflow_sig: "sigB",
  sample_image_id: "L1:b.png",
} as SignatureRow;

beforeEach(() => {
  gen.fetchRuleset.mockResolvedValue({ fields: { prompt: ["prompt.6.text"] } });
  gen.fetchWorkflow.mockResolvedValue({ prompt: { "6": {} } });
  gen.saveRuleset.mockResolvedValue(undefined);
  gen.deleteRuleset.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

function setup(confirmDiscard = vi.fn(async () => true)) {
  const notify = vi.fn();
  const onSaved = vi.fn();
  const view = renderHook(() =>
    useRulesetSession({ notify, onSaved, confirmDiscard }),
  );
  return { ...view, notify, onSaved, confirmDiscard };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function load(view: ReturnType<typeof setup>, sig = SIG_A) {
  await act(async () => {
    await view.result.current.selectSig(sig);
  });
}

describe("useRulesetSession", () => {
  it("starts clean", () => {
    const v = setup();
    expect(v.result.current.isDirty).toBe(false);
  });

  it("loading a signature seeds the baseline, so it stays clean", async () => {
    const v = setup();

    await load(v);

    expect(v.result.current.fields).toEqual({ prompt: ["prompt.6.text"] });
    expect(v.result.current.isDirty).toBe(false);
    expect(v.result.current.selected).toBe(SIG_A);
  });

  it("pinning a path makes the session dirty", async () => {
    const v = setup();
    await load(v);

    act(() => v.result.current.pinPath("model", "prompt.4.ckpt_name"));

    expect(v.result.current.isDirty).toBe(true);
  });

  it("removing a pin makes the session dirty", async () => {
    const v = setup();
    await load(v);

    act(() => v.result.current.removePath("prompt", "prompt.6.text"));

    expect(v.result.current.isDirty).toBe(true);
  });

  it("pinning the same path twice is a no-op", async () => {
    const v = setup();
    await load(v);

    act(() => v.result.current.pinPath("prompt", "prompt.6.text"));

    expect(v.result.current.fields.prompt).toEqual(["prompt.6.text"]);
    expect(v.result.current.isDirty).toBe(false);
  });

  it("saving resets the baseline, so the page stops being dirty", async () => {
    // The bug this guards: a missed baseline reset leaves the page permanently
    // dirty, prompting about changes that were already saved.
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "prompt.4.ckpt_name"));
    expect(v.result.current.isDirty).toBe(true);

    await act(async () => {
      await v.result.current.save();
    });

    expect(gen.saveRuleset).toHaveBeenCalledWith("sigA", {
      prompt: ["prompt.6.text"],
      model: ["prompt.4.ckpt_name"],
    });
    expect(v.result.current.isDirty).toBe(false);
    expect(v.onSaved).toHaveBeenCalled();
  });

  it("a failed save leaves the session dirty", async () => {
    gen.saveRuleset.mockRejectedValue(new Error("boom"));
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "x"));

    await act(async () => {
      await v.result.current.save();
    });

    expect(v.result.current.isDirty).toBe(true);
    expect(v.notify).toHaveBeenCalledWith(
      expect.stringContaining("Save failed"),
      "error",
    );
  });

  it("deleting clears the fields and the baseline together", async () => {
    const v = setup();
    await load(v);

    await act(async () => {
      await v.result.current.remove();
    });

    expect(v.result.current.fields).toEqual({});
    expect(v.result.current.isDirty).toBe(false);
  });

  it("declining the delete confirm does not delete", async () => {
    const v = setup(vi.fn(async () => false));
    await load(v);

    await act(async () => {
      await v.result.current.remove();
    });

    expect(gen.deleteRuleset).not.toHaveBeenCalled();
  });

  it("switching signature while clean does not prompt", async () => {
    const v = setup();
    await load(v);

    await load(v, SIG_B);

    expect(v.confirmDiscard).not.toHaveBeenCalled();
    expect(v.result.current.selected).toBe(SIG_B);
  });

  it("switching signature while dirty prompts first", async () => {
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "x"));

    await load(v, SIG_B);

    expect(v.confirmDiscard).toHaveBeenCalled();
    expect(v.result.current.selected).toBe(SIG_B);
  });

  it("declining the switch keeps the current signature and the edits", async () => {
    // "I switched signature and lost my pins" is the failure this prevents.
    const v = setup(vi.fn(async () => false));
    await load(v);
    act(() => v.result.current.pinPath("model", "keep-me"));

    await load(v, SIG_B);

    expect(v.result.current.selected).toBe(SIG_A);
    expect(v.result.current.fields.model).toEqual(["keep-me"]);
    expect(v.result.current.isDirty).toBe(true);
  });

  it("re-roots the graph so pinned paths read prompt.<node>...", async () => {
    gen.fetchWorkflow.mockResolvedValue({
      prompt: { "6": { class_type: "CLIPTextEncode" } },
      workflow: { nodes: [] },
    });
    const v = setup();

    await load(v);

    await waitFor(() =>
      expect(v.result.current.graph).toEqual({
        prompt: { "6": { class_type: "CLIPTextEncode" } },
        workflow: { nodes: [] },
      }),
    );
  });

  it("reports a failed load instead of leaving stale fields", async () => {
    gen.fetchRuleset.mockRejectedValue(new Error("nope"));
    const v = setup();

    await load(v);

    expect(v.notify).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load ruleset"),
      "error",
    );
  });

  it("after a failed load, save is refused and re-clicking retries", async () => {
    // An empty editor after a failed load is not the server's state; saving it
    // would overwrite the signature's real ruleset.
    gen.fetchRuleset.mockRejectedValueOnce(new Error("503"));
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "x"));

    await act(async () => {
      await v.result.current.save();
    });
    expect(gen.saveRuleset).not.toHaveBeenCalled();
    expect(v.result.current.loadFailed).toBe(true);

    await load(v); // same signature again → retry
    expect(v.result.current.loadFailed).toBe(false);
    expect(v.result.current.fields).toEqual({ prompt: ["prompt.6.text"] });
  });

  it("refuses to save while the ruleset is still loading", async () => {
    // Saving the interim {} would wipe the signature's stored pins.
    const v = setup();
    const pending = deferred<{ fields: Record<string, string[]> }>();
    gen.fetchRuleset.mockReturnValueOnce(pending.promise);

    let switching!: Promise<void>;
    act(() => {
      switching = v.result.current.selectSig(SIG_A);
    });
    await waitFor(() => expect(v.result.current.loading).toBe(true));
    await act(async () => {
      await v.result.current.save();
    });
    expect(gen.saveRuleset).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ fields: { prompt: ["p"] } });
      await switching;
    });
    expect(v.result.current.loading).toBe(false);
  });

  it("save and delete are no-ops with nothing selected", async () => {
    const v = setup();

    await act(async () => {
      await v.result.current.save();
      await v.result.current.remove();
    });

    expect(gen.saveRuleset).not.toHaveBeenCalled();
    expect(gen.deleteRuleset).not.toHaveBeenCalled();
  });

  it("switching resets the editor immediately, before the new ruleset loads", async () => {
    // "Values from the previous workflow stay": A's pins must not show under B.
    const v = setup();
    await load(v);
    const pending = deferred<{ fields: Record<string, string[]> }>();
    gen.fetchRuleset.mockReturnValueOnce(pending.promise);

    let switching!: Promise<void>;
    act(() => {
      switching = v.result.current.selectSig(SIG_B);
    });
    await waitFor(() => expect(v.result.current.selected).toBe(SIG_B));

    expect(v.result.current.fields).toEqual({});
    expect(v.result.current.isDirty).toBe(false);

    await act(async () => {
      pending.resolve({ fields: { seed: ["prompt.3.seed"] } });
      await switching;
    });
    expect(v.result.current.fields).toEqual({ seed: ["prompt.3.seed"] });
    expect(v.result.current.isDirty).toBe(false);
  });

  it("a failed workflow fetch still loads the new signature's fields", async () => {
    const v = setup();
    await load(v);
    gen.fetchRuleset.mockResolvedValueOnce({ fields: {} });
    gen.fetchWorkflow.mockRejectedValueOnce(new Error("404"));

    await load(v, SIG_B);

    expect(v.result.current.selected).toBe(SIG_B);
    expect(v.result.current.fields).toEqual({});
    expect(v.result.current.isDirty).toBe(false);
  });

  it("a load that resolves after a later switch is ignored", async () => {
    const v = setup();
    const slowA = deferred<{ fields: Record<string, string[]> }>();
    gen.fetchRuleset
      .mockReturnValueOnce(slowA.promise)
      .mockResolvedValueOnce({ fields: { model: ["prompt.4.ckpt_name"] } });

    let first!: Promise<void>;
    act(() => {
      first = v.result.current.selectSig(SIG_A);
    });
    await load(v, SIG_B);
    await act(async () => {
      slowA.resolve({ fields: { prompt: ["stale"] } });
      await first;
    });

    expect(v.result.current.selected).toBe(SIG_B);
    expect(v.result.current.fields).toEqual({ model: ["prompt.4.ckpt_name"] });
    expect(v.result.current.isDirty).toBe(false);
  });

  it("a save that resolves after switching does not dirty the next signature", async () => {
    // The spurious "Unsaved changes" prompt: A's fields became B's baseline.
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "x"));
    const slowSave = deferred<undefined>();
    gen.saveRuleset.mockReturnValueOnce(slowSave.promise);

    let saving!: Promise<void>;
    act(() => {
      saving = v.result.current.save();
    });
    gen.fetchRuleset.mockResolvedValueOnce({ fields: {} });
    await load(v, SIG_B);
    await act(async () => {
      slowSave.resolve(undefined);
      await saving;
    });

    expect(v.result.current.selected).toBe(SIG_B);
    expect(v.result.current.isDirty).toBe(false);
  });

  it("pinning then unpinning back to the saved state is clean", async () => {
    const v = setup();
    await load(v);

    act(() => v.result.current.pinPath("model", "x"));
    act(() => v.result.current.removePath("model", "x"));

    expect(v.result.current.isDirty).toBe(false);
  });

  it("re-selecting the current signature neither prompts nor drops edits", async () => {
    const v = setup();
    await load(v);
    act(() => v.result.current.pinPath("model", "keep-me"));

    await load(v, SIG_A);

    expect(v.confirmDiscard).not.toHaveBeenCalled();
    expect(v.result.current.fields.model).toEqual(["keep-me"]);
  });
});
