import React from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cn } from "../../lib/cn";

type Variant =
  | "primary"
  | "secondary"
  | "danger"
  | "dangerSoft"
  | "ghost";
type Size = "sm" | "md" | "icon" | "iconSm";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 hover:bg-brand-500 text-white border border-transparent",
  secondary:
    "bg-raised hover:bg-line text-neutral-100 border border-line hover:border-line-strong",
  danger: "bg-red-600 hover:bg-red-500 text-white border border-transparent",
  // Destructive but not the page's main act: quiet until hovered.
  dangerSoft:
    "bg-transparent hover:bg-red-600/15 text-red-300 border border-red-900/70 hover:border-red-700",
  ghost: "bg-transparent hover:bg-raised text-muted hover:text-neutral-100 border border-transparent",
};

const SIZES: Record<Size, string> = {
  // Fixed heights so buttons, inputs and selects line up in a toolbar row.
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  icon: "h-9 w-9",
  iconSm: "h-8 w-8",
};

type Look = {
  variant?: Variant;
  size?: Size;
  /** Toggle/pressed state: applies the brand accent regardless of variant. */
  active?: boolean;
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & Look;

function buttonClasses({ variant = "secondary", size = "md", active }: Look, className?: string) {
  return cn(
    "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none",
    SIZES[size],
    active
      ? "bg-brand-600/20 hover:bg-brand-600/30 text-brand-100 border border-brand-500/60"
      : VARIANTS[variant],
    className,
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant, size, active, className, children, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={buttonClasses({ variant, size, active }, className)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

/**
 * A Button that navigates. A real link, so it can be opened in a new tab,
 * copied, and shows its URL on hover; none of which a button calling
 * navigate() can do.
 */
export function ButtonLink({ variant, size, active, className, ...rest }: LinkProps & Look) {
  return <Link className={buttonClasses({ variant, size, active }, className)} {...rest} />;
}
