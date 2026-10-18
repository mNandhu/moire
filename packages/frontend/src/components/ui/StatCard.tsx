import React from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

/** Single metric tile for the overview: icon, big number, label. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  loading,
  to,
}: {
  icon: LucideIcon;
  label: React.ReactNode;
  value?: React.ReactNode;
  hint?: React.ReactNode;
  loading?: boolean;
  /** Where the card leads; renders it as a link. */
  to?: string;
}) {
  const className = cn(
    "rounded-xl border border-white/5 bg-surface bg-sheen shadow-panel p-4 text-left flex items-center gap-4",
    to && "card-hover",
  );
  const content = (
    <>
      <span
        className={cn(
          // One tint for every metric: colour here would only decorate.
          "inline-flex items-center justify-center w-10 h-10 rounded-lg shrink-0 text-brand-300 bg-brand-500/10",
        )}
      >
        <Icon size={20} />
      </span>
      <div className="min-w-0">
        {loading ? (
          <Skeleton className="h-7 w-16 mb-1" />
        ) : (
          <div className="text-2xl font-bold tabular-nums text-neutral-100 leading-none">
            {value}
          </div>
        )}
        {/* Hint shares the label's line: a second line would lift this
            card's number above its neighbours'. */}
        <div className="text-xs text-muted mt-1.5 truncate">
          {label}
          {hint && <span className="text-faint"> · {hint}</span>}
        </div>
      </div>
    </>
  );
  return to ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
