import { describe, expect, it } from "vitest";
import { aliasSwapWords, swapAliases } from "./promptAliases";

const places = { eyes_closed: { alias_of: "closed_eyes" }, longhair: { alias_of: "long_hair" }, solo: {} };

describe("swapAliases", () => {
  it("swaps every alias for its tag, weights and groups kept", () => {
    const s = swapAliases("1girl, (eyes_closed:1.2), solo, [longhair]", places);
    expect(s).toEqual({ text: "1girl, (closed eyes:1.2), solo, [long hair]", swapped: 2 });
  });

  it("leaves a prompt with no alias alone", () => {
    expect(swapAliases("1girl, solo", places)).toEqual({ text: "1girl, solo", swapped: 0 });
    expect(swapAliases("1girl, eyes_closed", undefined)).toEqual({ text: "1girl, eyes_closed", swapped: 0 });
  });

  it("drops an alias whose tag is already in, as the board's Remove duplicate does", () => {
    expect(swapAliases("closed_eyes, eyes_closed, solo", places).text).toBe("closed_eyes, solo");
    expect(swapAliases("eyes_closed, solo, closed_eyes", places).text).toBe("solo, closed_eyes");
  });

  it("keeps the first of two aliases of one tag", () => {
    const two = { ...places, eye_closed: { alias_of: "closed_eyes" } };
    expect(swapAliases("eye_closed, solo, eyes_closed", two).text).toBe("closed eyes, solo");
  });

  it("names the count", () => {
    expect(aliasSwapWords({ text: "", swapped: 0 })).toBeNull();
    expect(aliasSwapWords({ text: "", swapped: 1 })).toBe("Swap 1 alias for its tag");
    expect(aliasSwapWords({ text: "", swapped: 3 })).toBe("Swap 3 aliases for their tags");
  });
});
