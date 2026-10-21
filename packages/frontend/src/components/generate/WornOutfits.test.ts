import { describe, expect, it } from "vitest";
import { wornLine } from "./WornOutfits";
import type { WornOutfit } from "../../lib/generate";

const base = { name: "X", character: "hu_tao", shared: false, tags: [], image_id: null, hidden: false } as unknown as WornOutfit;
const name = () => "Hu Tao";

describe("wornLine", () => {
  it("says thumbnail, or how much it carries; a Default names its character", () => {
    expect(wornLine({ ...base, _id: "a", thumbnail: true, carried: 1, of: 3 }, name)).toBe("Its thumbnail");
    expect(wornLine({ ...base, _id: "a", thumbnail: false, carried: 2, of: 3 }, name)).toBe("Wears 2 of 3");
    expect(wornLine({ ...base, _id: "default", thumbnail: false, carried: 4, of: 5 }, name)).toBe("Hu Tao · wears 4 of 5");
  });
});
