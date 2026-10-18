import React from "react";
import type { LucideIcon } from "lucide-react";

/** Centered empty/zero-data panel with an icon, copy, and optional actions. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-28 px-4 text-center animate-fade-in">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-neutral-800/60 mb-6">
        <Icon size={40} className="text-faint" />
      </div>
      <h2 className="text-2xl font-semibold text-neutral-100 mb-2">{title}</h2>
      {description && (
        <p className="text-neutral-400 leading-relaxed mb-6 max-w-md">
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
