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

  it("drops an alias whose tag is already in, as the board's Remove duplicate does", () => {
    expect(swapAliases("fellatio, blowjob, solo", places).text).toBe("fellatio, solo");
    expect(swapAliases("blowjob, solo, fellatio", places).text).toBe("solo, fellatio");
  });

  it("keeps the first of two aliases of one tag", () => {
    const two = { ...places, bj: { alias_of: "fellatio" } };
    expect(swapAliases("bj, solo, blowjob", two).text).toBe("fellatio, solo");
  });

  it("names the count", () => {
    expect(aliasSwapWords({ text: "", swapped: 0 })).toBeNull();
    expect(aliasSwapWords({ text: "", swapped: 1 })).toBe("Swap 1 alias for its tag");
    expect(aliasSwapWords({ text: "", swapped: 3 })).toBe("Swap 3 aliases for their tags");
  });
});
