/** Batch display helpers shared by the Generations list, its rows and the
 * run panel's recent batches. Pure. */
import type { Batch, BatchState, BatchSummary, GenRequest, Output } from "./generate";

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

/** One cell of a batch's result grid: an image, a request still going, or a
 * request that failed / was cancelled (one cell however many images it was). */
export type ResultSlot =
  | { kind: "image"; req: GenRequest; number: number; out: Output }
  | { kind: "waiting"; req: GenRequest; number: number; first: boolean }
  | { kind: "failed"; req: GenRequest; number: number };

const GOING = new Set(["pending", "queued", "running"]);

/** Every request's cells in request order, as one flat grid. Pure. */
export function resultSlots(b: Pick<Batch, "requests">): ResultSlot[] {
  const out: ResultSlot[] = [];
  b.requests.forEach((req, i) => {
    const number = i + 1;
    if (req.outputs.length) {
      for (const o of req.outputs) out.push({ kind: "image", req, number, out: o });
    } else if (GOING.has(req.state)) {
      const n = req.images ?? 1;
      for (let k = 0; k < n; k++) out.push({ kind: "waiting", req, number, first: k === 0 });
    } else {
      out.push({ kind: "failed", req, number });
    }
  });
  return out;
}

/** Columns and rows for `n` cells: a few images stay big (one row fills the
 * view); more wrap at four across. In the output column, up to four are two
 * across and more are four across, so eight still fit in two rows; wide
 * images (`ratio` above 1) stack there instead, one across for two, two
 * across up to eight, then three. Pure. */
export function resultGrid(n: number, variant: "page" | "panel", ratio = 2 / 3): { cols: number; rows: number } {
  const m = Math.max(n, 1);
  const panel = ratio > 1 ? (m <= 2 ? 1 : m <= 8 ? 2 : 3) : m <= 2 ? m : m <= 4 ? 2 : 4;
  const cols = variant === "panel" ? panel : Math.min(m, 4);
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}
