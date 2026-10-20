import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

const OPEN_DELAY = 250;
// Long enough to move the pointer from the trigger onto the tip (it may hold a link).
const CLOSE_DELAY = 120;
const GAP = 8;

/**
 * The app's hover tip: use it instead of a native `title` where the text
 * explains something (why a control is off and how to turn it on). Opens on
 * hover or keyboard focus, stays open while the pointer is on the tip so a
 * link in it can be clicked, closes on Escape. Drawn in a portal so a
 * scrolling or clipped container never cuts it off; below the trigger, or
 * above when there's no room.
 */
export function Tooltip({
  content,
  children,
  className,
  side = "down",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  /** On the trigger wrapper (an inline-flex span). */
  className?: string;
  side?: "down" | "up";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const later = (fn: () => void, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(fn, ms);
  };
  const show = () => later(() => setOpen(true), OPEN_DELAY);
  const hide = () => later(() => setOpen(false), CLOSE_DELAY);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const t = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!t || !tip) return;
    const below = t.bottom + GAP + tip.height <= window.innerHeight;
    const up = side === "up" ? t.top - GAP - tip.height >= 0 : !below;
    const left = Math.max(8, Math.min(t.left, window.innerWidth - tip.width - 8));
    setPos({ top: up ? t.top - GAP - tip.height : t.bottom + GAP, left, up });
  }, [open, side]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        className={cn("inline-flex", className)}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            onMouseEnter={() => window.clearTimeout(timer.current)}
            onMouseLeave={hide}
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
            className="fixed z-[60] max-w-[min(20rem,calc(100vw-16px))] rounded-lg border border-line-strong bg-raised px-3 py-2 text-[13px] leading-snug text-neutral-100 shadow-panel"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
