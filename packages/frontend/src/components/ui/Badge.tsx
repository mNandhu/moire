import React from "react";
import { cn } from "../../lib/cn";

type Tone = "neutral" | "brand" | "success" | "danger" | "warning" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-raised border-line-strong text-neutral-300",
  brand: "bg-brand-900/30 border-brand-700 text-brand-200",
  success: "bg-emerald-900/30 border-emerald-700 text-emerald-200",
  danger: "bg-red-900/30 border-red-700 text-red-200",
  warning: "bg-amber-900/25 border-amber-700 text-amber-200",
  info: "bg-sky-900/30 border-sky-700 text-sky-200",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
