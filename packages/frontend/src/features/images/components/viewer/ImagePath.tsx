import { useLayoutEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import type React from "react";

/**
 * The image's full path under the header: two lines at most, so a deep
 * folder never pushes the panel down, and a click unfolds the rest in place.
 * Copying is its own button. Mount it keyed by image, so each opens folded.
 */
export function ImagePath({ path, onCopy }: { path: string; onCopy: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  // Only a path the clamp actually cut can unfold; a short one is plain text.
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [path, open, clamped]);

  return (
    <div className="group mt-1 flex max-w-full items-start gap-1 text-xs text-faint">
      {clamped || open ? (
        <button
          ref={ref as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn("min-w-0 text-left [overflow-wrap:anywhere] hover:text-neutral-200", !open && "line-clamp-2")}
        >
          {path}
        </button>
      ) : (
        <span ref={ref} className="min-w-0 line-clamp-2 [overflow-wrap:anywhere]">
          {path}
        </span>
      )}
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy path"
        className="mt-px shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-neutral-200 focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"
      >
        <Copy size={11} />
      </button>
    </div>
  );
}
