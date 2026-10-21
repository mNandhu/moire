import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

export type DropdownItem = {
  label: string;
  icon?: React.ReactNode;
  variant?: "default" | "danger";
  /** Shown at the row's end (a status badge). */
  hint?: React.ReactNode;
  onClick: () => void;
};

export function DropdownMenu({
  label,
  items,
  "aria-label": ariaLabel,
  icon,
  size,
  variant = "secondary",
  footer,
}: {
  label?: React.ReactNode;
  items: DropdownItem[];
  "aria-label"?: string;
  /** Icon-only trigger (e.g. a row's "more actions" ⋯). No label, no chevron. */
  icon?: React.ReactNode;
  size?: "sm" | "md";
  /** The labelled trigger's look. */
  variant?: "secondary" | "primary";
  /** Controls under the items that set how they run (the menu stays open). */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      // The open menu has the keys: a page's own shortcuts (the viewer
      // closes on Escape, steps on arrows) must not act behind it.
      if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
      }
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant={icon ? "ghost" : variant}
        size={icon ? (size === "sm" ? "iconSm" : "icon") : size}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={icon ? ariaLabel : undefined}
        active={icon ? open : undefined}
      >
        {icon ?? (
          <>
            {label}
            <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
          </>
        )}
      </Button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 top-full mt-1 z-50 rounded-lg border border-line-strong bg-raised shadow-panel py-1",
            footer ? "w-max min-w-[16rem] max-w-[24rem]" : "min-w-[180px]",
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors text-left",
                item.variant === "danger"
                  ? "text-red-300 hover:bg-red-600/15"
                  : "text-neutral-200 hover:bg-line",
              )}
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              {item.icon}
              {item.label}
              {item.hint && <span className="ml-auto shrink-0 whitespace-nowrap pl-3">{item.hint}</span>}
            </button>
          ))}
          {footer && <div className="mt-1 border-t border-line px-3 pb-1 pt-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
