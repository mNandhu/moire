import type { Face } from "@/features/characters/lib/character";
// Discover's picks: which tags, character and model a deal shows. Pure, with
// the random source passed in so tests can pin it.

export type Rng = () => number;

/** `n` distinct items of `list` in random order (all of it when shorter). */
export function sample<T>(list: readonly T[], n: number, rng: Rng = Math.random): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}

/** One random item of `list`, undefined when it is empty. */
export function pickOne<T>(list: readonly T[], rng: Rng = Math.random): T | undefined {
  return sample(list, 1, rng)[0];
}

// The rarest quarter of the tags, but never fewer than this many to pick from.
const RARE_SHARE = 0.25;
const RARE_POOL_MIN = 24;

/**
 * `n` random rare tags: from the rarest quarter of `tags` (at least
 * `RARE_POOL_MIN` of them), counting only tags on two or more images, as a
 * tag on one image leads to that image alone. Rarest first.
 */
export function rareTags<T extends { count: number }>(tags: readonly T[], n: number, rng: Rng = Math.random): T[] {
  const ranked = tags.filter((t) => t.count >= 2).sort((a, b) => a.count - b.count);
  const pool = ranked.slice(0, Math.max(RARE_POOL_MIN, Math.ceil(ranked.length * RARE_SHARE)));
  return sample(pool, n, rng).sort((a, b) => a.count - b.count);
}

/** A pick made for one deal. */
export type Held<P> = { deal: number; value: P };

/**
 * The pick for `deal`: made once, from the first `data` to arrive for it,
 * and kept in `store` under `name`. A refetch of `data` (window focus, a tag
 * edit) leaves it as it is; only a new deal picks again.
 */
export function heldPick<T, P>(
  store: Map<string, Held<unknown>>,
  name: string,
  deal: number,
  data: T | undefined,
  pick: (data: T) => P,
): P | undefined {
  const had = store.get(name) as Held<P> | undefined;
  if (had && had.deal === deal) return had.value;
  if (data === undefined) return undefined;
  const value = pick(data);
  store.set(name, { deal, value });
  return value;
}

/**
 * `first`, then `rest` filling up to `n`, each image once (the same image
 * can be in both: a favorite is also one not seen lately).
 */
export function fillUp<T extends { _id: string }>(first: readonly T[], rest: readonly T[], n: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of [...first, ...rest]) {
    if (out.length >= n) break;
    if (seen.has(x._id)) continue;
    seen.add(x._id);
    out.push(x);
  }
  return out;
}

/** Fewer images than this and a shelf hides: one or two read as broken. */
export const MIN_SHELF = 4;

/**
 * Where across the banner's frame (0..1) a character's face lands once
 * `crop` (an `avatarCrop`) is applied: the crop may not reach the place
 * asked for when the image is too narrow. Null without a crop.
 */
export function faceLanding(
  crop: { width: string; left: string } | null,
  a: { face: readonly number[] | null; focus: readonly [number, number] | null },
): number | null {
  if (!crop) return null;
  const fx = a.focus?.[0] ?? a.face?.[0] ?? 0.5;
  return (fx * parseFloat(crop.width) + parseFloat(crop.left)) / 100;
}

// The fade's stops: an eased ramp (a straight one shows a line where it ends).
const EASE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.18, 0.08],
  [0.39, 0.3],
  [0.6, 0.62],
  [0.79, 0.88],
  [1, 1],
];

/**
 * The banner image's left fade, as a CSS gradient: eased, starting at the
 * image's edge (a fade begun before it leaves the edge part-opaque, a hard
 * line) and ending a little before the face (`landing`, 0..1 across) so the
 * face stays sharp, between 30% and 72% across. A long fade starts later.
 */
export function bannerFade(landing: number | null): string {
  const end = Math.min(0.72, Math.max(0.3, (landing ?? 0.7) - 0.12));
  const start = Math.max(0, end - 0.57);
  const stops = EASE.map(([t, a]) => `rgb(0 0 0 / ${a}) ${+((start + (end - start) * t) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** The picture Discover's banner shows, and how to frame it. */
export type BannerPicture = {
  id: string | null;
  src: string | null;
  face: Face | null;
  focus: readonly [number, number] | null;
  /** Width / height. */
  aspect: number | null;
};

/** Wider than this reads as landscape. */
const LANDSCAPE = 1.3;

/**
 * Which picture the banner shows for `c`: their avatar when it has a face
 * to frame (found, or a point the user set); else a landscape image of
 * theirs when there is one among `images` (it fills the wide banner where a
 * portrait can't); else the avatar. Undefined while `images` loads and the
 * choice depends on them.
 */
export function bannerPicture(
  c: {
    thumb_image_id: string | null;
    thumb_url: string | null;
    face: Face | null;
    focus: readonly [number, number] | null;
    aspect: number | null;
  },
  images: readonly { _id: string; thumb_url: string | null; width: number | null; height: number | null }[] | undefined,
): BannerPicture | undefined {
  const avatar = { id: c.thumb_image_id, src: c.thumb_url, face: c.face, focus: c.focus, aspect: c.aspect };
  if (c.face || c.focus || (c.aspect ?? 0) >= LANDSCAPE) return avatar;
  if (!images) return undefined;
  const wide = images.find((i) => i.thumb_url && i.width && i.height && i.width / i.height >= LANDSCAPE);
  if (!wide) return avatar;
  return { id: wide._id, src: wide.thumb_url, face: null, focus: null, aspect: wide.width! / wide.height! };
}
