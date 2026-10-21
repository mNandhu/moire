/**
 * How a count becomes ComfyUI requests (mirrors `generator_graph.split_requests`).
 *
 * - images: the Generator's batch_size is mapped; `count` images go out as
 *   requests of at most `perRequest` ("8 images, 4 × 2").
 * - runs: batch_size isn't Moiré's to set (the workflow builds it), so
 *   `count` is a number of runs, each as big as the workflow makes it.
 */
export type CountMode = { kind: "images"; perRequest: number } | { kind: "runs" };

export function splitRequests(count: number, perRequest: number | null): (number | null)[] {
  if (count < 1) return [];
  if (!perRequest || perRequest < 1) return Array(count).fill(null);
  const full = Math.floor(count / perRequest);
  const rest = count % perRequest;
  return [...Array(full).fill(perRequest), ...(rest ? [rest] : [])];
}

const runs = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;

/** The count with its unit: "3 images", or "3 runs" when the workflow sets
 * its own batch size. */
export function countText(count: number, mode: CountMode): string {
  return mode.kind === "images" ? `${count} ${count === 1 ? "image" : "images"}` : runs(count);
}

/** The short label by the count: "2 runs of 2", "3 runs of up to 3", or
 * for runs, who sets their size. */
export function countLabel(count: number, mode: CountMode): string {
  if (mode.kind === "runs") return "Batch size set by the workflow";
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
  if (mode.kind === "runs")
    return `The workflow builds its own batch size, so each run makes however many images it sets. Map batch_size in the workflow's setup to count images instead.`;
  const total = `${countText(count, mode)} in total.`;
  if (mode.perRequest <= 1) return `${total} ComfyUI makes one at a time (the batch size), so this is ${runs(count)}.`;
  const sizes = splitRequests(count, mode.perRequest) as number[];
  // The sizes only while they are few enough to read.
  const listed = sizes.length <= 6 ? `: ${sizes.join(", ")}` : "";
  return `${total} ComfyUI makes up to ${mode.perRequest} at a time (the batch size), so this is ${runs(sizes.length)}${listed}.`;
}

/** Fixed seeds count up per request, as the backend sends them. */
export function fixedSeeds(seed: number, requests: number): number[] {
  return Array.from({ length: requests }, (_, i) => seed + i);
}

/** A random seed for the dice button (within ComfyUI's range). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 50);
}
