/**
 * Back/forward availability for the sidebar's history buttons.
 *
 * react-router stores its position in the browser history as
 * `history.state.idx`. Going back is possible above 0. Forward is the
 * highest idx reached since the last push (a push drops the entries
 * ahead); a pop or a replace moves within that range.
 */
export type NavAction = "PUSH" | "POP" | "REPLACE";

export function historyIdx(state: unknown): number {
  const idx = (state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" ? idx : 0;
}

export function nextMaxIdx(prevMax: number, idx: number, action: NavAction): number {
  return action === "PUSH" ? idx : Math.max(prevMax, idx);
}
