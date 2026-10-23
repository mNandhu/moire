import { useEffect, useRef } from "react";
import { hasModifier, isFormField } from "../lib/dom";
import { useOverlayOpen } from "../lib/backgroundLocation";

/**
 * One global keydown listener with the guards every shortcut handler used to
 * hand-roll. A binding fires for `keys` (matched against `e.key`) or for its
 * own `match`; the first matching binding wins.
 *
 * Guards, applied before any binding runs:
 *  - `enabled` false: nothing is listening;
 *  - an image opened over this page (OverlayOpenContext) owns the keys, unless
 *    `overlay: "ignore"` (ImageView itself, which IS that overlay);
 *  - a text field has focus, unless `fields: true`;
 *  - the key carries Ctrl/Cmd/Alt, which belongs to the browser (Ctrl+1 tab
 *    switch, Alt+Left back, Ctrl+X cut), unless the binding's `mods` says
 *    otherwise: "ctrl" lets Ctrl/Cmd through (never Alt), "any" lets all
 *    through and leaves the check to `match`;
 *  - `skipHandled`: someone already preventDefault-ed it (a dialog's Escape).
 *
 * Bindings are read through a ref, so they may close over fresh state without
 * re-subscribing the listener.
 */
export type Hotkey = {
  keys?: string[];
  match?: (e: KeyboardEvent) => boolean;
  mods?: "none" | "ctrl" | "any";
  run: (e: KeyboardEvent) => void;
};

export type HotkeyOptions = {
  enabled?: boolean;
  overlay?: "bail" | "ignore";
  fields?: boolean;
  skipHandled?: boolean;
  /** Listen in the capture phase on `document` (ahead of a dialog's key trap). */
  capture?: boolean;
};

/** Whether `e` passes the modifier rule of `mods`. */
export function modsAllow(e: KeyboardEvent, mods: Hotkey["mods"] = "none"): boolean {
  if (mods === "any") return true;
  if (mods === "ctrl") return !e.altKey;
  return !hasModifier(e);
}

export function useHotkeys(bindings: Hotkey[], options: HotkeyOptions = {}) {
  const { enabled = true, overlay = "bail", fields = false, skipHandled = false, capture = false } = options;
  const overlayOpen = useOverlayOpen();
  const ref = useRef(bindings);
  ref.current = bindings;

  const blocked = overlay === "bail" && overlayOpen;
  useEffect(() => {
    if (!enabled || blocked) return;
    const target: Document | Window = capture ? document : window;
    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (skipHandled && e.defaultPrevented) return;
      if (!fields && isFormField(e.target)) return;
      for (const b of ref.current) {
        if (!modsAllow(e, b.mods)) continue;
        const hit = b.match ? b.match(e) : !!b.keys?.includes(e.key);
        if (!hit) continue;
        b.run(e);
        return;
      }
    };
    target.addEventListener("keydown", onKey, capture);
    return () => target.removeEventListener("keydown", onKey, capture);
  }, [enabled, blocked, fields, skipHandled, capture]);
}
