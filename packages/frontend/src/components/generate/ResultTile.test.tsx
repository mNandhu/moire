import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UndoActionContext } from "../../lib/undoActions";
import type { UndoAction } from "../../lib/undoTimeline";
import { ToastProvider } from "../Toasts";
import type { Output } from "../../lib/generate";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { ResultTile } from "./ResultTile";

vi.mock("../../lib/imageMutations", () => ({
  setQuarantine: vi.fn(async () => undefined),
  setScore: vi.fn(async () => undefined),
}));

const out = { image_id: "lib:a.png", in_library: true, thumb_url: "/t/a", quarantined: false, score: 0 } as unknown as Output;

function tile(o: Output = out, onUndo?: (a: UndoAction) => void) {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ToastProvider>
          <UndoActionContext.Provider value={onUndo ?? null}>
            <ResultTile out={o} ratio={1} onChanged={() => undefined} />
          </UndoActionContext.Provider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container.querySelector<HTMLElement>("[aria-keyshortcuts]")!;
}

describe("ResultTile keys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records a rejection for the page's undo, which restores it", async () => {
    const recorded: UndoAction[] = [];
    fireEvent.keyDown(tile(out, (a) => recorded.push(a)), { key: "x" });
    await vi.waitFor(() => expect(recorded).toHaveLength(1));
    await recorded[0].undo();
    expect(setQuarantine).toHaveBeenLastCalledWith("lib:a.png", false);
    await recorded[0].redo();
    expect(setQuarantine).toHaveBeenLastCalledWith("lib:a.png", true);
  });

  it("keeps, rejects and scores with bare keys", () => {
    const el = tile();
    fireEvent.keyDown(el, { key: "x" });
    expect(setQuarantine).toHaveBeenLastCalledWith("lib:a.png", true);
    fireEvent.keyDown(el, { key: "k" });
    expect(setQuarantine).toHaveBeenLastCalledWith("lib:a.png", false);
    fireEvent.keyDown(el, { key: "4" });
    expect(setScore).toHaveBeenLastCalledWith("lib:a.png", 4);
  });

  it("leaves Ctrl, Cmd and Alt combinations to the browser", () => {
    const el = tile();
    fireEvent.keyDown(el, { key: "x", ctrlKey: true });
    fireEvent.keyDown(el, { key: "k", metaKey: true });
    fireEvent.keyDown(el, { key: "3", ctrlKey: true });
    fireEvent.keyDown(el, { key: "3", altKey: true });
    expect(setQuarantine).not.toHaveBeenCalled();
    expect(setScore).not.toHaveBeenCalled();
  });

  it("takes no score while rejected", () => {
    const el = tile({ ...out, quarantined: true } as Output);
    fireEvent.keyDown(el, { key: "2" });
    expect(setScore).not.toHaveBeenCalled();
  });
});
