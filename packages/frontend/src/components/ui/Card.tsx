import React from "react";
import { cn } from "../../lib/cn";

export function Card({
  className,
  hover,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-white/5 bg-surface bg-sheen shadow-panel",
        hover && "card-hover",
        className,
      )}
      {...rest}
    />
  );
}

/** A titled content section — used for settings groups and framed panels. */
export function Section({
  title,
  description,
  actions,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cn("p-5", className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            {title && (
              <h3 className="font-semibold text-neutral-100">{title}</h3>
            )}
            {description && (
              <p className="text-xs text-muted mt-0.5">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </Card>
  );
}
