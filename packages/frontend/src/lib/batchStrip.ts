// What the viewer's "This batch" strip shows. Pure, so the choice between a
// Generation batch and a group is tested apart from the component.

/** Which images make up the strip: a Moiré output's Generation batch (one
 * press of Queue, what its batch page shows), else the image's group (same
 * workflow, same prompt: its seeds and reruns, whatever made them). */
export type BatchOf = { genBatch: number } | { groupId: string };

/** The strip for an image: its Generation batch when Moiré queued it, so a
 * second Queue press of the same prompt (another checkpoint, a requeue) is
 * not shown as the same batch; else its group; null when it has neither. */
export function stripOf(genBatch: number | null | undefined, groupId: string | null | undefined): BatchOf | null {
  if (genBatch != null) return { genBatch };
  return groupId ? { groupId } : null;
}

/** The strip's feed query: the viewer's `scope` narrowed to the batch. */
export function batchStripQuery(of: BatchOf, scope: string): string {
  const sp = new URLSearchParams(scope);
  if ("genBatch" in of) sp.set("gen_batch", String(of.genBatch));
  else sp.set("group_id", of.groupId);
  return sp.toString();
}
