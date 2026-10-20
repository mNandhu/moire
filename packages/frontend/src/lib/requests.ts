/**
 * How a count becomes ComfyUI requests (mirrors `generator_graph.split_requests`).
 *
 * - images: the Generator's batch_size is mapped; `count` images go out as
 *   requests of at most `perRequest` ("8 images, 4 × 2").
 * - requests: batch_size isn't mapped but the graph has a literal one;
 *   `count` is a number of requests ("8 × 4 = 32 images").
 * - unknown: batch_size is built at run time ("8 × ?").
 */
export type CountMode =
  | { kind: "images"; perRequest: number }
  | { kind: "requests"; literal: number }
  | { kind: "unknown" };

export function splitRequests(count: number, perRequest: number | null): (number | null)[] {
  if (count < 1) return [];
  if (!perRequest || perRequest < 1) return Array(count).fill(null);
  const full = Math.floor(count / perRequest);
  const rest = count % perRequest;
  return [...Array(full).fill(perRequest), ...(rest ? [rest] : [])];
}

const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** The short label by the count: "2 runs of 2", "3 runs of up to 3",
 * "8 × 4 = 32 images", "8 × ?". */
export function countLabel(count: number, mode: CountMode): string {
  if (mode.kind === "unknown") return `${count} × ?`;
  if (mode.kind === "requests") return `${count} × ${mode.literal} = ${count * mode.literal} images`;
  const sizes = splitRequests(count, mode.perRequest) as number[];
  if (mode.perRequest <= 1) return runs(count);
  // One smaller run when fewer images are asked than a run makes.
  if (sizes.length === 1) return `${runs(1)} of ${sizes[0]}`;
  return sizes.every((n) => n === mode.perRequest)
    ? `${runs(sizes.length)} of ${mode.perRequest}`
    : `${runs(sizes.length)} of up to ${mode.perRequest}`;
}

/** The label's tooltip: what the count and batch size mean together. */
export function countHint(count: number, mode: CountMode): string | undefined {
  if (mode.kind !== "images") return undefined;
  const sizes = splitRequests(count, mode.perRequest) as number[];
  return (
    `${count} ${count === 1 ? "image" : "images"} in total. ComfyUI makes up to ${mode.perRequest} at a time ` +
    `(the batch size), so this is ${runs(sizes.length)}: ${sizes.join(", ")}.`
  );
}

/** Fixed seeds count up per request, as the backend sends them. */
export function fixedSeeds(seed: number, requests: number): number[] {
  return Array.from({ length: requests }, (_, i) => seed + i);
}

/** A random seed for the dice button (within ComfyUI's range). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 50);
}
