import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTagThumbnail, deleteCharacter, setTagThumbnail, updateCharacter } from "./tagMutations";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown = {}) {
  const spy = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

const JSON_POST = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
};

describe("tag mutations", () => {
  it("setTagThumbnail encodes the raw prefixed tag", async () => {
    const spy = mockFetch();
    await setTagThumbnail("manual:my fav", "L1:a.jpg");
    expect(spy).toHaveBeenCalledWith("/api/v1/tags/thumbnail/manual%3Amy%20fav", {
      ...JSON_POST,
      body: JSON.stringify({ image_id: "L1:a.jpg" }),
    });
  });

  it("sends DELETE and PATCH with the method each route takes", async () => {
    const spy = mockFetch();
    await clearTagThumbnail("smile");
    expect(spy).toHaveBeenLastCalledWith("/api/v1/tags/thumbnail/smile", { method: "DELETE" });
    await deleteCharacter("hu_tao_(genshin_impact)");
    expect(spy).toHaveBeenLastCalledWith("/api/v1/tags/character?tag=hu_tao_%28genshin_impact%29", { method: "DELETE" });
    await updateCharacter("x", { name: "X" });
    expect(spy).toHaveBeenLastCalledWith("/api/v1/tags/character?tag=x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
  });
});
