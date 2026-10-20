import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useHistoryNav } from "../hooks/useHistoryNav";
import { cn } from "../lib/cn";

// Mouse and trackpad only: touch screens have their own back gesture, and
// the forward button needs a hover to appear.
const POINTER_ONLY = "hidden [@media(hover:hover)_and_(pointer:fine)]:inline-flex";

type Spot = { top: number; left: number; gap: number };

/**
 * The sidebar's back button. Hovering it shows a forward button floating
 * just past the sidebar's edge, when there is somewhere to go forward to.
 * The forward button sits in a portal: the sidebar clips its overflow and
 * its transformed wrapper would also capture `position: fixed`.
 */
export function BackButton({ className }: { className?: string }) {
  const { canBack, canForward, back, forward } = useHistoryNav();
  const ref = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [spot, setSpot] = useState<Spot | null>(null);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const show = () => {
    window.clearTimeout(hideTimer.current);
    const btn = ref.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const edge = btn.closest("aside")?.getBoundingClientRect().right ?? r.right;
    // Starts right at the back button so the pointer never crosses a gap
    // on its way over; the padding carries it out past the sidebar.
    setSpot({ top: r.top + r.height / 2, left: r.right, gap: edge - r.right + 6 });
  };
  const hide = () => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setSpot(null), 150);
  };

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => canBack && back()}
        onPointerEnter={show}
        onPointerLeave={hide}
        aria-disabled={!canBack}
        title="Go back"
        aria-label="Go back"
        className={cn(
          POINTER_ONLY,
          "p-1.5 rounded-lg transition-colors",
          canBack
            ? "text-faint hover:text-neutral-100 hover:bg-raised/60"
            : "text-faint/40 cursor-default",
          className,
        )}
      >
        <ArrowLeft size={18} />
      </button>
      {spot &&
        canForward &&
        createPortal(
          <div
            className="fixed z-50 -translate-y-1/2 flex items-center"
            style={{ top: spot.top, left: spot.left, paddingLeft: spot.gap }}
            onPointerEnter={show}
            onPointerLeave={hide}
          >
            <button
              type="button"
              onClick={() => {
                setSpot(null);
                forward();
              }}
              title="Go forward"
              aria-label="Go forward"
              className="p-1.5 rounded-lg bg-raised border border-line text-muted hover:text-neutral-100 hover:border-line-strong shadow-lg animate-fade-in"
            >
              <ArrowRight size={18} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
