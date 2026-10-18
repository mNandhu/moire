import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Centered empty/zero-data panel with an icon, copy, and optional actions.
 * `compact` is the in-panel size (an empty card, an unselected pane); the
 * default is for a page with nothing on it at all.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  compact,
  className,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-4 text-center animate-fade-in",
        compact ? "py-12" : "py-28",
        className,
      )}
    >
      <div
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-raised",
          compact ? "w-12 h-12 mb-4" : "w-20 h-20 mb-6",
        )}
      >
        <Icon size={compact ? 22 : 40} className="text-faint" />
      </div>
      <h2
        className={cn(
          "font-semibold text-neutral-100",
          compact ? "text-base mb-1" : "text-2xl mb-2",
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "text-muted leading-relaxed max-w-md",
            compact ? "text-sm" : "",
            actions ? (compact ? "mb-4" : "mb-6") : "",
          )}
        >
          {description}
        </p>
      )}
      {actions && (
        <div className="flex flex-col sm:flex-row gap-2.5 justify-center">
          {actions}
        </div>
      )}
    </div>
  );
}
