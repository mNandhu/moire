import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Skeleton } from "./Skeleton";

/** Single metric tile for the overview: icon, big number, label. */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "brand",
  loading,
  onClick,
}: {
  icon: LucideIcon;
  label: React.ReactNode;
  value?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "brand" | "emerald" | "blue" | "neutral";
  loading?: boolean;
  onClick?: () => void;
}) {
  const tones = {
    brand: "text-brand-300 bg-brand-500/10",
    emerald: "text-emerald-300 bg-emerald-500/10",
    blue: "text-blue-300 bg-blue-500/10",
    neutral: "text-neutral-300 bg-neutral-700/30",
  }[tone];

  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={cn(
        "rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 text-left flex items-center gap-4 card-hover",
        onClick && "cursor-pointer w-full",
      )}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center w-11 h-11 rounded-lg shrink-0",
          tones,
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
        <div className="text-xs text-neutral-400 mt-1.5 truncate">{label}</div>
        {hint && <div className="text-2xs text-faint truncate">{hint}</div>}
      </div>
    </Comp>
  );
}
