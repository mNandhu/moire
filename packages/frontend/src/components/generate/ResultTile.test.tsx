import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../Toasts";
import type { Output } from "../../lib/generate";
import { setQuarantine, setScore } from "../../lib/imageMutations";
import { ResultTile } from "./ResultTile";

vi.mock("../../lib/imageMutations", () => ({
  setQuarantine: vi.fn(async () => undefined),
  setScore: vi.fn(async () => undefined),
}));

const out = { image_id: "lib:a.png", in_library: true, thumb_url: "/t/a", quarantined: false, score: 0 } as unknown as Output;

function tile(o: Output = out) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <ResultTile out={o} ratio={1} onChanged={() => undefined} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return screen.getByTitle(/K (keep|restore)/);
}

describe("ResultTile keys", () => {
  beforeEach(() => vi.clearAllMocks());

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
