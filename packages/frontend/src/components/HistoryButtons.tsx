import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useHistoryNav } from "../hooks/useHistoryNav";
import { cn } from "../lib/cn";

// Mouse and trackpad only: touch screens have their own back gesture, and
// the forward button needs a hover to appear.
const POINTER_ONLY = "hidden [@media(hover:hover)_and_(pointer:fine)]:inline-flex";

type Spot = { top: number; left: number; gap: number; width: number; height: number };

const enabledTone = "text-faint hover:text-neutral-100 hover:bg-raised/60";
const disabledTone = "text-faint/40 cursor-default";

/**
 * The sidebar's back and forward buttons. With a label (sidebar expanded)
 * the two sit side by side. Without one (collapsed) only back shows, and
 * hovering it floats a forward button just past the sidebar's edge when
 * there is somewhere to go forward to.
 */
export function BackButton({ className, label }: { className?: string; label?: string }) {
  if (label) return <InlineHistoryButtons label={label} className={className} />;
  return <FloatingForwardBackButton className={className} />;
}

function InlineHistoryButtons({ className, label }: { className?: string; label: string }) {
  const { canBack, canForward, back, forward } = useHistoryNav();
  return (
    <div className={cn(POINTER_ONLY, "w-full items-center gap-1", className)}>
      <button
        type="button"
        onClick={() => canBack && back()}
        aria-disabled={!canBack}
        aria-label="Go back"
        className={cn(
          "flex flex-1 items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors",
          canBack ? enabledTone : disabledTone,
        )}
      >
        <ArrowLeft size={18} />
        {label}
      </button>
      <button
        type="button"
        onClick={() => canForward && forward()}
        aria-disabled={!canForward}
        aria-label="Go forward"
        className={cn(
          "flex items-center justify-center p-2 rounded-lg transition-colors",
          canForward ? enabledTone : disabledTone,
        )}
      >
        <ArrowRight size={18} />
      </button>
    </div>
  );
}

/**
 * Collapsed sidebar: the forward button sits in a portal, since the sidebar
 * clips its overflow and its transformed wrapper would also capture
 * `position: fixed`.
 */
function FloatingForwardBackButton({ className }: { className?: string }) {
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
    // Same box as the back button, so the pair reads as one control.
    setSpot({
      top: r.top + r.height / 2,
      left: r.right,
      gap: edge - r.right + 6,
      width: r.width,
      height: r.height,
    });
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
        aria-label="Go back"
        className={cn(
          POINTER_ONLY,
          "p-1.5 rounded-lg transition-colors",
          canBack ? enabledTone : disabledTone,
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
              aria-label="Go forward"
              style={{ width: spot.width, height: spot.height }}
              className="flex items-center justify-center rounded-lg bg-raised border border-line text-muted hover:text-neutral-100 hover:border-line-strong shadow-lg animate-fade-in"
            >
              <ArrowRight size={18} />
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
