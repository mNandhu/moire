import type { KeyboardEvent } from "react";
import { WEIGHT_STEP, bumpWeight, changedSpan } from "../../lib/promptEdit";
import { GENERATE } from "../../lib/shortcuts";

/**
 * Ctrl+Up / Ctrl+Down (Cmd on a Mac) in a prompt textarea: the term at the
 * caret, or the selection, weighed as in ComfyUI. True when the key was the
 * weight shortcut and the text changed. The edit goes in as typing would
 * (`insertText`), so Ctrl+Z undoes it; `onChange` is the fallback.
 */
export function onWeightKey(e: KeyboardEvent<HTMLTextAreaElement>, onChange: (text: string) => void): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !GENERATE.weight.keys.includes(e.key)) return false;
  const el = e.currentTarget;
  const next = bumpWeight(el.value, el.selectionStart, el.selectionEnd, e.key === "ArrowUp" ? WEIGHT_STEP : -WEIGHT_STEP);
  if (!next) return false;
  e.preventDefault();
  const change = changedSpan(el.value, next.text);
  el.setSelectionRange(change.start, change.end);
  const typed = document.execCommand?.("insertText", false, change.text);
  if (typed && el.value === next.text) el.setSelectionRange(next.start, next.end);
  else {
    onChange(next.text);
    requestAnimationFrame(() => el.setSelectionRange(next.start, next.end));
  }
  return true;
}
