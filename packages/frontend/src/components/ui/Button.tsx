import React from "react";
import { cn } from "../../lib/cn";

type Variant =
  | "primary"
  | "secondary"
  | "success"
  | "danger"
  | "dangerSoft"
  | "ghost";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 hover:bg-brand-500 text-white border border-transparent",
  secondary:
    "bg-raised hover:bg-line text-neutral-100 border border-line hover:border-line-strong",
  success: "bg-emerald-600 hover:bg-emerald-500 text-white border border-transparent",
  danger: "bg-red-600 hover:bg-red-500 text-white border border-transparent",
  dangerSoft:
    "bg-red-600/20 hover:bg-red-600/30 text-red-200 border border-red-700",
  ghost: "bg-transparent hover:bg-raised text-muted hover:text-neutral-100 border border-transparent",
};

const SIZES: Record<Size, string> = {
  // Fixed heights so buttons, inputs and selects line up in a toolbar row.
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "h-9 w-9",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** Toggle/pressed state — applies the brand accent regardless of variant. */
  active?: boolean;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", active, className, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
          SIZES[size],
          active
            ? "bg-brand-600/20 hover:bg-brand-600/30 text-brand-100 border border-brand-500/60"
            : VARIANTS[variant],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
