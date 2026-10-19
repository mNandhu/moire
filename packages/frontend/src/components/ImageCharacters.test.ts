import { describe, it, expect } from "vitest";
import { characterName } from "./ImageCharacters";

describe("characterName", () => {
  it("splits the series off a Danbooru character tag", () => {
    expect(characterName("nahida_(genshin_impact)")).toEqual({
      name: "nahida",
      series: "genshin impact",
    });
    expect(characterName("2b_(nier:automata)")).toEqual({ name: "2b", series: "nier:automata" });
    expect(characterName("frieren")).toEqual({ name: "frieren", series: null });
  });
});
