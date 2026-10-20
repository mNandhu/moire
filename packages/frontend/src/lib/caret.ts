/**
 * Where a caret sits inside a textarea, in pixels from its top-left (scroll
 * included), measured on an invisible copy of it that wraps the same way.
 */
const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
  "tabSize",
] as const;

export function caretOffset(el: HTMLTextAreaElement, pos: number): { left: number; top: number; height: number } {
  const style = window.getComputedStyle(el);
  const copy = document.createElement("div");
  for (const k of COPIED) copy.style[k] = style[k];
  copy.style.position = "absolute";
  copy.style.visibility = "hidden";
  copy.style.top = "0";
  copy.style.left = "-9999px";
  copy.style.whiteSpace = "pre-wrap";
  copy.style.overflowWrap = "break-word";
  copy.textContent = el.value.slice(0, pos);
  const mark = document.createElement("span");
  // Something to measure even at the end of a line.
  mark.textContent = el.value.slice(pos) || ".";
  copy.appendChild(mark);
  document.body.appendChild(copy);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const out = {
    left: mark.offsetLeft - el.scrollLeft,
    top: mark.offsetTop - el.scrollTop,
    height: lineHeight,
  };
  document.body.removeChild(copy);
  return out;
}
