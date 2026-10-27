/** Batch display helpers shared by the Generations list, its rows and the
 * run panel's recent batches. Pure. */
import { retryable } from "./batchActions";
import { batchLeft, leftLabel } from "./eta";
import { etaLabel } from "./format";
import type {
  ActiveBatch,
  Batch,
  BatchInputs,
  BatchState,
  BatchSummary,
  CharacterInput,
  GenRequest,
  Output,
  PromptPart,
} from "./generate";

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
export function batchLine(b: Pick<BatchSummary, "images" | "kept" | "failed" | "arriving">): string {
  const parts = [`${b.images} ${b.images === 1 ? "image" : "images"}`];
  const rejected = b.images - b.kept - b.arriving;
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

/** A cell's identity across renders: cells come and go as requests finish. */
export const slotKey = (s: ResultSlot, i: number) => (s.kind === "image" ? `${s.req._id}:${s.out.idx}` : `${s.req._id}:${s.kind}:${i}`);

export function cellTitle(s: ResultSlot): string {
  return `Request ${s.number}, seed ${s.req.seed}`;
}

/** What a failed cell says: cancelled, an empty result, lost, or failed
 * (with the image count when it made several). */
export function failureLabel(req: Pick<GenRequest, "state" | "images">): string {
  if (req.state === "cancelled") return "Cancelled";
  if (req.state === "done") return "Returned 0 images";
  if (req.state === "lost") return "Lost";
  return `Failed${req.images && req.images > 1 ? `, ${req.images} images` : ""}`;
}

/** Why a slot has no thumbnail in the strip. */
export function slotWhy(s: ResultSlot): "failed" | "running" | "waiting" | "missing" {
  if (s.kind === "failed") return "failed";
  if (s.kind === "waiting") return s.req.state === "running" ? "running" : "waiting";
  return "missing";
}

/** The strip's default pick: the image being made, else the last one made. */
export function newestSlot(slots: readonly ResultSlot[]): number {
  const making = slots.findIndex((x) => x.kind === "waiting");
  const lastMade = slots.map((x) => x.kind).lastIndexOf("image");
  return making >= 0 ? making : lastMade >= 0 ? lastMade : slots.length - 1;
}

/** The index shown: the picked key's place (it follows its image as cells
 * come and go), else the newest. */
export function shownSlot(slots: readonly ResultSlot[], picked: string | null): number {
  const keys = slots.map(slotKey);
  return Math.max(0, picked ? keys.indexOf(picked) : newestSlot(slots));
}

/** The index `d` steps from `at`, wrapping. */
export const stepIndex = (at: number, d: number, n: number) => (at + d + n) % n;

/** Columns and rows for `n` cells on a batch's page: a few images stay big
 * (one row fills the view); more wrap at four across. Pure. */
export function resultGrid(n: number): { cols: number; rows: number } {
  const cols = Math.min(Math.max(n, 1), 4);
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}


/** Time ComfyUI spent on a batch's finished requests (failed ones too),
 * and per image over the runs that made images; null before any has a
 * time. Pure. */
export function batchRunTime(
  requests: readonly Pick<GenRequest, "ran" | "outputs" | "state">[],
): { total: number; perImage: number | null; images: number } | null {
  const timed = requests.filter((q) => q.ran != null);
  if (!timed.length) return null;
  const total = timed.reduce((a, q) => a + (q.ran ?? 0), 0);
  const made = timed.filter((q) => q.state === "done" && q.outputs.length);
  const images = made.reduce((a, q) => a + q.outputs.length, 0);
  const spent = made.reduce((a, q) => a + (q.ran ?? 0), 0);
  return { total, perImage: images ? spent / images : null, images };
}

/** A batch's numbers as the batch page and the output panel show them, each
 * in its own words: images made and how many are in the library, runs and
 * images per run, run time, time left, the requests a retry picks up, and
 * runs still going or done. Pure. */
export function batchStats(b: Pick<Batch, "requests" | "inputs">): {
  images: number;
  inLibrary: number;
  runs: number;
  perRun: number | null;
  took: ReturnType<typeof batchRunTime>;
  left: ReturnType<typeof batchLeft>;
  failed: GenRequest[];
  unfinished: number;
  done: number;
} {
  const outputs = b.requests.flatMap((q) => q.outputs);
  const unfinished = b.requests.filter((q) => GOING.has(q.state)).length;
  return {
    images: outputs.length,
    inLibrary: outputs.filter((o) => o.in_library).length,
    runs: b.requests.length,
    perRun: b.inputs.per_request,
    took: batchRunTime(b.requests),
    left: batchLeft(b.requests),
    failed: retryable(b.requests),
    unfinished,
    done: b.requests.length - unfinished,
  };
}

/** The characters a batch was queued with; older batches have one `character`. Pure. */
export function batchCast(i: Pick<BatchInputs, "characters" | "character">): CharacterInput[] {
  return i.characters ?? (i.character ? [i.character] : []);
}

/** Which layers' text the inputs list shows, and as what. */
const PART_ROW: Partial<Record<string, string>> = { prefix: "Prefix", prompt: "Prompt", style: "LoRA words" };

/** The layers' text rows of a batch's inputs: Prefix (its preset's name,
 * else its text), Prompt and LoRA words, the empty ones left out. Pure. */
export function partRows(positive: readonly PromptPart[] | null | undefined): { role: string; label: string; value: string }[] {
  return (positive ?? [])
    .filter((p) => p.kind === "text" && p.text?.trim() && p.role && p.role in PART_ROW)
    .map((p) => ({ role: p.role!, label: PART_ROW[p.role!]!, value: (p.role === "prefix" ? p.label || p.text : p.text)! }));
}

/** A batch cover's width / height: the batch's own shape (every image in a
 * batch is the same size), kept between 2:3 and 3:2 so one very wide or very
 * tall batch doesn't dwarf its row; 3:4 when the size isn't known. Pure. */
export function coverAspect(width: number | null, height: number | null): number {
  if (!width || !height) return 3 / 4;
  return Math.min(3 / 2, Math.max(2 / 3, width / height));
}

/** Which of `n` images a pointer at `x` across a cover `width` wide shows:
 * the cover split into `n` equal strips, left to right. Pure. */
export function scrubIndex(x: number, width: number, n: number): number {
  if (n <= 1 || width <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((x / width) * n)));
}

type Turn = Pick<ActiveBatch, "running" | "finished" | "starts_in" | "done_in">;

/** Nothing of it has started: it waits for its first turn. */
export function isWaiting(a: Turn): boolean {
  return !a.running && a.finished === 0;
}

/** When a queued batch starts or is done, its turns among the others counted:
 * "starts in about 2m", "about 9m left". Null when there's no number. */
export function turnLabel(a: Turn): string | null {
  if (isWaiting(a)) return a.starts_in != null && a.starts_in >= 3 ? `starts in ${etaLabel(a.starts_in)}` : null;
  return a.done_in != null ? leftLabel({ seconds: a.done_in, over: false }) : null;
}
