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
  /** Heading the item sits under; consecutive items share it. */
  group?: string;
  /** A rule above the item (a way out after a list, "All …"). */
  divider?: boolean;
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
  trigger,
  onOpenChange,
}: {
  label?: React.ReactNode;
  items: DropdownItem[];
  "aria-label"?: string;
  /** Icon-only trigger (e.g. a row's "more actions" ⋯). No label, no chevron. */
  icon?: React.ReactNode;
  size?: "sm" | "md";
  /** The labelled trigger's look; "link" is bare text, like a panel's
   * header actions. */
  variant?: "secondary" | "primary" | "link";
  /** Controls under the items that set how they run (the menu stays open). */
  footer?: React.ReactNode;
  /** Told when the menu opens or closes (load its items only when wanted). */
  onOpenChange?: (open: boolean) => void;
  /** A whole element as the trigger (a card): a click anywhere on it opens
   * the menu beside it, on its right (its left when there's no room). */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => onOpenChangeRef.current?.(open), [open]);
  // A card's menu: beside it, on the side with room.
  const [onLeft, setOnLeft] = useState(false);
  const toggle = () => {
    if (trigger && !open && ref.current) {
      setOnLeft(ref.current.getBoundingClientRect().right + 280 > window.innerWidth);
    }
    setOpen((v) => !v);
  };

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
      {trigger ? (
        <div
          role="button"
          tabIndex={0}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest("a")) toggle();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
          className="cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        >
          {trigger}
        </div>
      ) : variant === "link" && !icon ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
        >
          {label}
          <ChevronDown size={12} className={cn("transition-transform", open && "rotate-180")} />
        </button>
      ) : (
      <Button
        variant={icon ? "ghost" : variant === "link" ? "secondary" : variant}
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
      )}

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute z-50 rounded-lg border border-line-strong bg-raised shadow-panel py-1",
            trigger ? (onLeft ? "right-full top-2 mr-2" : "left-full top-2 ml-2") : "right-0 top-full mt-1",
            footer || trigger || items.some((x) => x.group) ? "w-max min-w-[16rem] max-w-[24rem]" : "min-w-[180px]",
          )}
        >
          {items.map((item, i) => (
            <React.Fragment key={i}>
            {item.group && item.group !== items[i - 1]?.group && (
              <div className={cn("px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-faint", i > 0 && "mt-1 border-t border-line")}>
                {item.group}
              </div>
            )}
            {item.divider && <div className="my-1 border-t border-line" />}
            <button
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
            </React.Fragment>
          ))}
          {footer && <div className="mt-1 border-t border-line px-3 pb-1 pt-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
