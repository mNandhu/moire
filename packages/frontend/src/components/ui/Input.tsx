import React from "react";
import { cn } from "../../lib/cn";

const FIELD =
  "w-full h-9 rounded-lg bg-canvas border border-line px-3 text-sm text-neutral-100 placeholder:text-faint hover:border-line-strong focus:border-brand-500/70 transition-colors";

// Native selects keep their OS-drawn arrow unless appearance is reset;
// `.select-chevron` (index.css) draws one that matches the chrome.
const SELECT = "select-chevron pr-8";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(FIELD, className)} {...rest} />;
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cn(FIELD, SELECT, className)} {...rest} />;
});

/** Label + optional hint wrapper for form controls. */
export function Field({
  label,
  hint,
  htmlFor,
  className,
  children,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      {label && (
        <label
          htmlFor={htmlFor}
          className="block text-xs font-medium text-muted mb-1.5"
        >
          {label}
        </label>
      )}
      {children}
      {hint && <p className="text-xs text-faint mt-1.5">{hint}</p>}
    </div>
  );
}
