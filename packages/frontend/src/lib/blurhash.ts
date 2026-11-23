const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

const base83 = (s: string, from: number, to: number) => {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 83 + DIGITS.indexOf(s[i]);
  return v;
};
const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (v: number) => {
  const c = Math.max(0, Math.min(1, v));
  return c <= 0.0031308
    ? Math.trunc(c * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255 + 0.5);
};
const signPow = (v: number, e: number) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);

// cos(PI * x * i / size) for each component i and pixel x, by size and count.
const cosines = new Map<number, Float64Array>();
function cosTable(size: number, comps: number): Float64Array {
  const key = size * 16 + comps;
  let t = cosines.get(key);
  if (!t) {
    t = new Float64Array(size * comps);
    for (let i = 0; i < comps; i++) {
      for (let x = 0; x < size; x++) t[i * size + x] = Math.cos((Math.PI * x * i) / size);
    }
    cosines.set(key, t);
  }
  return t;
}

/**
 * The `blurhash` package's `decode`, pixel for pixel, with the cosines
 * looked up instead of computed twice per pixel per component: every gallery
 * tile decodes one as it mounts, ~3x faster this way. Throws on a malformed
 * hash, as the package does.
 */
export function decodeBlurhash(hash: string, width: number, height: number): Uint8ClampedArray {
  if (!hash || hash.length < 6) throw new Error("The blurhash string must be at least 6 characters");
  const size = base83(hash, 0, 1);
  const ny = Math.floor(size / 9) + 1;
  const nx = (size % 9) + 1;
  if (hash.length !== 4 + 2 * nx * ny) throw new Error("blurhash length mismatch");
  const max = (base83(hash, 1, 2) + 1) / 166;
  const colors = new Float64Array(nx * ny * 3);
  const dc = base83(hash, 2, 6);
  colors[0] = toLinear(dc >> 16);
  colors[1] = toLinear((dc >> 8) & 255);
  colors[2] = toLinear(dc & 255);
  for (let i = 1; i < nx * ny; i++) {
    const ac = base83(hash, 4 + i * 2, 6 + i * 2);
    colors[i * 3] = signPow((Math.floor(ac / 361) - 9) / 9, 2) * max;
    colors[i * 3 + 1] = signPow(((Math.floor(ac / 19) % 19) - 9) / 9, 2) * max;
    colors[i * 3 + 2] = signPow(((ac % 19) - 9) / 9, 2) * max;
  }
  const cx = cosTable(width, nx);
  const cy = cosTable(height, ny);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < ny; j++) {
        const fy = cy[j * height + y];
        for (let i = 0; i < nx; i++) {
          // Same operands, same order as the package: identical rounding.
          const basis = cx[i * width + x] * fy;
          const c = (i + j * nx) * 3;
          r += colors[c] * basis;
          g += colors[c + 1] * basis;
          b += colors[c + 2] * basis;
        }
      }
      const o = 4 * x + y * width * 4;
      out[o] = toSrgb(r);
      out[o + 1] = toSrgb(g);
      out[o + 2] = toSrgb(b);
      out[o + 3] = 255;
    }
  }
  return out;
}

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
    px = decodeBlurhash(hash, N, N);
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
    const [r, g, b] = Array.from(decodeBlurhash(hash, 1, 1), (v) => v / 255);
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
