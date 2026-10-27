import { decode } from "blurhash";

/**
 * The colour an image glows with (CSS `rgb(...)`): its most prominent vivid
 * hue, not its average. An average washes out to grey-white whenever a
 * strong colour sits on a light frame (yellow hair on a white background),
 * so cells of a small decode vote for their hue weighted by chroma, as
 * `ambientPalette` does across images, and the winner's cells are averaged.
 * A frame with no real colour glows its plain average. Null for a missing
 * or invalid hash.
 */
export function accentFromBlurhash(hash?: string | null): string | null {
  if (!hash) return null;
  const N = 8;
  let px: Uint8ClampedArray;
  try {
    px = decode(hash, N, N);
  } catch {
    return null;
  }
  const buckets = new Map<number, { weight: number; rgb: [number, number, number] }>();
  const sum = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
    const hc = hueChromaOf(r / 255, g / 255, b / 255);
    if (hc.chroma <= 0.08) continue;
    const key = Math.floor(hc.hue / 30);
    const bucket = buckets.get(key) ?? { weight: 0, rgb: [0, 0, 0] };
    bucket.weight += hc.chroma;
    bucket.rgb[0] += r * hc.chroma;
    bucket.rgb[1] += g * hc.chroma;
    bucket.rgb[2] += b * hc.chroma;
    buckets.set(key, bucket);
    total += hc.chroma;
  }
  const cells = px.length / 4;
  // Too little colour to call (a grey or near-black frame): its average.
  const top = total / cells >= 0.03 ? [...buckets.values()].sort((a, b) => b.weight - a.weight)[0] : undefined;
  const [r, g, b] = top ? top.rgb.map((v) => v / top.weight) : sum.map((v) => v / cells);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function hueChromaOf(r: number, g: number, b: number): { hue: number; chroma: number } {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma === 0) return { hue: 0, chroma: 0 };
  let h: number;
  if (max === r) h = ((g - b) / chroma) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;
  return { hue: Math.round((h * 60 + 360) % 360), chroma };
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
    return hueChromaOf(r, g, b);
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
export function ambientPalette(hashes: (string | null | undefined)[], n = 3): string[] {
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
