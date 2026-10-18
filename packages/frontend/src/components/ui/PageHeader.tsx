import React from "react";
import { cn } from "../../lib/cn";
import { useDocumentTitle } from "../../hooks/useDocumentTitle";

/**
 * Per-page title bar: title + optional count and right-aligned actions.
 * Gives every route a consistent anchor so users always know where they are.
 * No icon tile: the sidebar already carries each route's icon.
 */
export function PageHeader({
  title,
  count,
  countLabel,
  description,
  actions,
  className,
  children,
}: {
  title: React.ReactNode;
  count?: number;
  /** Qualifier rendered after the count, e.g. "loaded" for a paged feed whose
   * total isn't known. Without it a growing number reads as a wrong total. */
  countLabel?: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  /** Optional row rendered below the title (search, filters, tabs…). */
  children?: React.ReactNode;
}) {
  // Plain-string titles also name the browser tab; every routed page has one.
  useDocumentTitle(typeof title === "string" ? title : null);

  return (
    <div className={cn("mb-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
            <h2 className="text-2xl font-semibold text-neutral-50 flex items-baseline gap-2.5 truncate">
              {title}
              {typeof count === "number" && (
                <span className="text-sm font-normal text-faint tabular-nums">
                  {count.toLocaleString()}
                  {countLabel && (
                    <span className="ml-1 font-normal">{countLabel}</span>
                  )}
                </span>
              )}
            </h2>
            {description && (
              <p className="mt-0.5 text-sm text-muted truncate">{description}</p>
            )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
