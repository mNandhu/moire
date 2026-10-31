import type React from "react";
import { useEffect, useRef, useState } from "react";
import { snapSheet } from "../lib/sheetSnap";

// The phone's details sheet: how much of it shows at rest, below the image.
const SHEET_PEEK_PERCENT = 45;
export const SHEET_PEEK = `${SHEET_PEEK_PERCENT}dvh`;

/**
 * ImageView's details panel: open or collapsed, and on a phone a sheet over
 * the image's lower part, resting at a peek, under the image, or pulled up to
 * read; dragged by its top. `sheetDrag` goes on whatever drags the sheet
 * (empty off a phone); `asideRef` and `sheetStyle` on the sheet itself (the
 * ref sizes the stops, the style places it at one or under the finger).
 */
export function useDetailsSheet(phone: boolean) {
  // Docked beside the image from lg up; below that the panel is a drawer over
  // the stage, so a phone opens on the image, not on a wall of metadata.
  const [infoOpen, setInfoOpen] = useState(
    () => window.matchMedia?.("(min-width: 1024px)")?.matches ?? true,
  );
  const [sheet, setSheet] = useState<"peek" | "full">("peek");
  const asideRef = useRef<HTMLElement>(null);
  const [dragY, setDragY] = useState<number | null>(null);
  const dragRef = useRef<{ y0: number; from: number; y: number; t: number; v: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  // Down from fully open, px: open, peek, closed.
  const sheetStops = () => {
    const h = asideRef.current?.offsetHeight ?? window.innerHeight;
    return [0, h - (window.innerHeight * SHEET_PEEK_PERCENT) / 100, h];
  };
  const sheetDrag: React.HTMLAttributes<HTMLDivElement> = phone
    ? {
        style: { touchAction: "none" },
        onPointerDown: (e) => {
          // A drag on touch ends without a click to clear this; a new press does.
          justDragged.current = false;
          // Typing and picking in a field aren't drags.
          if (e.button || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
          const stops = sheetStops();
          dragRef.current = {
            y0: e.clientY,
            from: sheet === "full" ? stops[0] : stops[1],
            y: e.clientY,
            t: e.timeStamp,
            v: 0,
            moved: false,
          };
        },
        onPointerMove: (e) => {
          const d = dragRef.current;
          if (!d) return;
          const dy = e.clientY - d.y0;
          // A tap on a header button stays a tap.
          if (!d.moved) {
            if (Math.abs(dy) < 6) return;
            d.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          const dt = e.timeStamp - d.t;
          if (dt > 0) d.v = (e.clientY - d.y) / dt;
          d.y = e.clientY;
          d.t = e.timeStamp;
          setDragY(Math.max(0, d.from + dy));
        },
        onPointerUp: (e) => {
          const d = dragRef.current;
          dragRef.current = null;
          if (!d?.moved) return;
          justDragged.current = true;
          // Held still before letting go: no flick.
          const v = e.timeStamp - d.t > 80 ? 0 : d.v;
          const stop = snapSheet(Math.max(0, d.from + e.clientY - d.y0), v, sheetStops());
          setDragY(null);
          if (stop === 2) setInfoOpen(false);
          else setSheet(stop === 0 ? "full" : "peek");
        },
        onPointerCancel: () => {
          dragRef.current = null;
          setDragY(null);
        },
        // The click that ends a drag isn't a press of what it started on.
        onClickCapture: (e) => {
          if (!justDragged.current) return;
          justDragged.current = false;
          e.preventDefault();
          e.stopPropagation();
        },
      }
    : {};
  // Leaving phone width mid-drag (a rotation) takes the handlers that would
  // end it; drop the drag so the sheet isn't left where the finger was.
  useEffect(() => {
    if (phone) return;
    dragRef.current = null;
    setDragY(null);
  }, [phone]);
  // Opens the panel; on a phone, at the peek.
  const open = () => {
    setSheet("peek");
    setInfoOpen(true);
  };
  const sheetStyle: React.CSSProperties | undefined = phone
    ? {
        transform:
          dragY != null
            ? `translateY(${dragY}px)`
            : !infoOpen
              ? "translateY(100%)"
              : sheet === "peek"
                ? `translateY(calc(100% - ${SHEET_PEEK}))`
                : "none",
        transition: dragY != null ? "none" : undefined,
      }
    : undefined;
  return { infoOpen, setInfoOpen, open, sheet, setSheet, dragging: dragY != null, sheetDrag, sheetStyle, asideRef };
}
