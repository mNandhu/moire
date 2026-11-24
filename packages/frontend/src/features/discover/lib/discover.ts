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
