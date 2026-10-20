/** Batch display helpers shared by the Generations list, its rows and the
 * run panel's recent batches. Pure. */
import type { BatchState, BatchSummary } from "./generate";

export const STATE_LABEL: Record<BatchState, string> = {
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function stateTone(s: BatchState): "brand" | "neutral" | "success" | "danger" {
  if (s === "running") return "brand";
  if (s === "failed") return "danger";
  if (s === "done") return "success";
  return "neutral";
}

/** "8 images, 1 failed · 4 rejected" style summary line. */
export function batchLine(b: Pick<BatchSummary, "images" | "kept" | "failed">): string {
  const parts = [`${b.images} ${b.images === 1 ? "image" : "images"}`];
  const rejected = b.images - b.kept;
  if (b.failed) parts.push(`${b.failed} failed`);
  if (rejected > 0) parts.push(`${rejected} rejected`);
  return parts.join(", ");
}

/** Short time: "14:02" today, "Yesterday", else the date. */
export function whenLabel(epochSeconds: number, now: Date = new Date()): string {
  const d = new Date(epochSeconds * 1000);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Day heading for the Generations list. */
export function dayLabel(epochSeconds: number, now: Date = new Date()): string {
  const w = whenLabel(epochSeconds, now);
  if (w === "Yesterday") return w;
  return w.includes(":") ? "Today" : w;
}
