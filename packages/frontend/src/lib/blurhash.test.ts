import { describe, expect, it } from "vitest";
import { encode } from "blurhash";
import { accentFromBlurhash, ambientPalette } from "./blurhash";

describe("accentFromBlurhash", () => {
  it("returns null for a missing hash", () => {
    expect(accentFromBlurhash(undefined)).toBeNull();
    expect(accentFromBlurhash("")).toBeNull();
  });

  it("returns null for an invalid hash", () => {
    expect(accentFromBlurhash("not-a-hash")).toBeNull();
  });

  it("decodes a valid hash to an rgb() string", () => {
    const accent = accentFromBlurhash("LEHV6nWB2yk8pyo0adR*.7kCMdnj");
    expect(accent).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

/** A 4x4 BlurHash of one flat colour. */
function solid(r: number, g: number, b: number): string {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i += 4) px.set([r, g, b, 255], i);
  return encode(px, 4, 4, 1, 1);
}

const hueOf = (c: string) => Number(/^hsl\((\d+)/.exec(c)?.[1]);

describe("ambientPalette", () => {
  it("follows the dominant hue, not a saturated outlier", () => {
    const blue = solid(20, 30, 200);
    const neonRed = solid(250, 10, 10);
    const palette = ambientPalette([...Array(8).fill(blue), neonRed]);
    expect(palette).toHaveLength(1);
    expect(hueOf(palette[0])).toBeGreaterThan(220);
    expect(hueOf(palette[0])).toBeLessThan(245);
  });

  it("keeps a second hue that carries a real share of the library", () => {
    const blue = solid(20, 30, 200);
    const red = solid(200, 20, 20);
    const palette = ambientPalette([blue, blue, blue, red, red]);
    expect(palette.map(hueOf)).toEqual([expect.any(Number), expect.any(Number)]);
    expect(hueOf(palette[0])).toBeGreaterThan(200);
    expect(hueOf(palette[1])).toBeLessThan(15);
  });

  it("skips greys and missing or invalid hashes", () => {
    const grey = solid(90, 90, 90);
    expect(ambientPalette([grey, undefined, "not-a-hash"])).toEqual([]);
  });

  it("gives a dim but clearly coloured image full strength", () => {
    const darkRed = solid(70, 10, 10);
    expect(ambientPalette([darkRed])).toEqual(["hsl(0 70% 55%)"]);
  });

  it("ignores near-black noise", () => {
    expect(ambientPalette([solid(12, 8, 8), solid(6, 9, 6)])).toEqual([]);
  });

  it("returns at most n colours", () => {
    const hashes = [solid(230, 20, 20), solid(20, 230, 20), solid(20, 20, 230)];
    expect(ambientPalette(hashes, 2)).toHaveLength(2);
  });
});
