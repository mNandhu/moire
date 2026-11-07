import { describe, expect, it } from "vitest";
import { aliasSwapWords, swapAliases } from "./promptAliases";

const places = { blowjob: { alias_of: "fellatio" }, sideboob: { alias_of: "breasts_apart" }, solo: {} };

describe("swapAliases", () => {
  it("swaps every alias for its tag, weights and groups kept", () => {
    const s = swapAliases("1girl, (blowjob:1.2), solo, [sideboob]", places);
    expect(s).toEqual({ text: "1girl, (fellatio:1.2), solo, [breasts apart]", swapped: 2 });
  });

  it("leaves a prompt with no alias alone", () => {
    expect(swapAliases("1girl, solo", places)).toEqual({ text: "1girl, solo", swapped: 0 });
    expect(swapAliases("1girl, blowjob", undefined)).toEqual({ text: "1girl, blowjob", swapped: 0 });
  });

  it("swaps an alias whose tag is already in, leaving the repeat for Clean up", () => {
    expect(swapAliases("fellatio, blowjob", places).text).toBe("fellatio, fellatio");
  });

  it("names the count", () => {
    expect(aliasSwapWords({ text: "", swapped: 0 })).toBeNull();
    expect(aliasSwapWords({ text: "", swapped: 1 })).toBe("Swap 1 alias for its tag");
    expect(aliasSwapWords({ text: "", swapped: 3 })).toBe("Swap 3 aliases for their tags");
  });
});
