import { decode } from "blurhash";

/**
 * Derive a single accent color (CSS `rgb(...)`) from a BlurHash by decoding it
 * to one pixel. Returns null for a missing/invalid hash.
 */
export function accentFromBlurhash(hash?: string): string | null {
  if (!hash) return null;
  try {
    const [r, g, b] = decode(hash, 1, 1);
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return null;
  }
}

/**
 * Hue (degrees) and chroma (0-1, max minus min channel) of a BlurHash's
 * average colour. Chroma rather than HSL saturation: saturation blows up for
 * near-black colours (rgb(12,8,8) is "20% saturated red"), so dark frames
 * would vote for whatever hue their noise happens to lean towards.
 */
function hueChroma(hash: string): { hue: number; chroma: number } | null {
  try {
    // Array.from first: mapping the Uint8ClampedArray itself would clamp
    // every channel back to an integer, i.e. 0 or 1.
    const [r, g, b] = Array.from(decode(hash, 1, 1), (v) => v / 255);
    const max = Math.max(r, g, b);
    const chroma = max - Math.min(r, g, b);
    if (chroma === 0) return { hue: 0, chroma: 0 };
    let h: number;
    if (max === r) h = ((g - b) / chroma) % 6;
    else if (max === g) h = (b - r) / chroma + 2;
    else h = (r - g) / chroma + 4;
    return { hue: Math.round((h * 60 + 360) % 360), chroma };
  } catch {
    return null;
  }
}

/**
 * The dominant hues among the given BlurHashes, for the ambient wash behind
 * the gallery. Each image votes for its hue (30° buckets) weighted by its
 * chroma, so greys and near-blacks barely count and a library of blue frames
 * reads as blue even when a few have a red or green highlight; buckets under
 * 15% of the vote are dropped. Output is a fixed saturation and lightness so
 * the wash has the same strength whatever the library. Strongest first.
 */
export function ambientPalette(hashes: (string | undefined)[], n = 3): string[] {
  const buckets = new Map<number, { weight: number; hueSum: number }>();
  let total = 0;
  for (const h of hashes) {
    const hc = h ? hueChroma(h) : null;
    if (!hc || hc.chroma <= 0.04) continue;
    const key = Math.floor(hc.hue / 30);
    const b = buckets.get(key) ?? { weight: 0, hueSum: 0 };
    b.weight += hc.chroma;
    b.hueSum += hc.hue * hc.chroma;
    buckets.set(key, b);
    total += hc.chroma;
  }
  return [...buckets.values()]
    .filter((b) => b.weight >= total * 0.15)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n)
    .map((b) => `hsl(${Math.round(b.hueSum / b.weight)} 70% 55%)`);
}
