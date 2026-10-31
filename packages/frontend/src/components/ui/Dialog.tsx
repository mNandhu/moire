import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

/**
 * Modal shell: dimmed backdrop, centered card, Escape / backdrop-click to close,
 * focus kept inside while open and restored to the opener afterwards.
 *
 * Keydowns never reach the page underneath. A native `confirm()` used to
 * freeze all JS while open; this doesn't, so without that the gallery's
 * window-level shortcuts (Escape clears the selection, Enter opens an image,
 * digits rate) would fire under the dialog. Keys typed inside the panel reach
 * their target and are stopped as they bubble out of the overlay; keys whose
 * target is outside (focus fell to <body> when the focused button unmounted,
 * e.g. "Preview" swapping to "Add") are swallowed at the document.
 *
 * Escape from inside the panel closes the dialog as it bubbles out, unless a
 * control on the way claimed it (called `preventDefault` or stopped it): an
 * open list, menu or inline editor closes itself and the next Escape closes the
 * dialog. Escape from outside the panel, and Tab, are handled at the document
 * (capture phase), where only the topmost open dialog reacts, so a confirm
 * opened over a dialog closes alone.
 *
 * Rendered into <body>: a transformed ancestor (the image view's sliding side
 * panel) would otherwise make `fixed` mean "fixed to the panel".
 */
const openStack: object[] = [];

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  initialFocusRef,
  labelledBy = "dialog-title",
  ariaLabel,
  placement = "center",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  /** Element to focus on open; defaults to the first focusable. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  labelledBy?: string;
  /** For a dialog with no title. */
  ariaLabel?: string;
  /** "top": anchored near the top, so a panel whose height changes as you
   * type (a search) doesn't jump. */
  placement?: "center" | "top";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = {};
    openStack.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== token) return;
      const panel = panelRef.current;
      const inside = !!panel && panel.contains(e.target as Node);
      if (!inside) e.stopPropagation();
      // From inside, Escape is decided as it leaves the panel (below).
      if (e.key === "Escape" && !inside) {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      // Focus trap: wrap Tab / Shift+Tab inside the panel, and pull focus back
      // in if it escaped to <body>.
      const els = focusables(panel);
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (!inside || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      openStack.splice(openStack.indexOf(token), 1);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const target = initialFocusRef?.current ?? focusables(panelRef.current)[0];
    (target ?? panelRef.current)?.focus();
    return () => opener?.focus?.();
  }, [open, initialFocusRef]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[950] flex justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in",
        placement === "top" ? "items-start pt-[12vh]" : "items-center",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" && !e.isDefaultPrevented()) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? labelledBy : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={cn(
          "w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-5 shadow-xl outline-none",
          className,
        )}
      >
        {title && (
          <div id={labelledBy} className="text-lg font-semibold text-neutral-100">
            {title}
          </div>
        )}
        {description && (
          <div className="mt-1.5 text-sm text-neutral-400">{description}</div>
        )}
        {children && <div className={title || description ? "mt-4" : ""}>{children}</div>}
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The footer of a dialog that confirms something: `start` (a Delete, a
 * count) at the left, then Cancel and the confirm button at the right. The
 * confirm button is off while `pending` (its action is in flight) or
 * `disabled`.
 */
export function DialogFooter({
  onCancel,
  onConfirm,
  confirmLabel = "Save",
  pending,
  disabled,
  start,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: React.ReactNode;
  pending?: boolean;
  disabled?: boolean;
  start?: React.ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      {start}
      <span className="flex-1" />
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="primary" onClick={onConfirm} disabled={disabled} pending={pending}>
        {confirmLabel}
      </Button>
    </div>
  );
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}
