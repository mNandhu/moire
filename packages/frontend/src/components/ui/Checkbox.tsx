import React from "react";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Brand-styled checkbox with an optional label + hint. Controlled via
 * `checked`/`onChange`; keeps a real <input> for accessibility and focus.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  id,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        // Grid: box + label share row 1 (items-center aligns them to each
        // other regardless of line-height); the hint drops to row 2 under
        // the label. Avoids strut/line-height misalignment entirely.
        // content-start: in a stretched grid cell (two checkboxes side by
        // side, one with a longer hint) the spare height would otherwise be
        // shared into row 1 and push the shorter one's box down.
        "grid grid-cols-[auto_minmax(0,1fr)] content-start items-center gap-x-2.5 select-none",
        disabled ? "opacity-50" : "cursor-pointer",
        className,
      )}
    >
      <span className="relative inline-flex">
        <input
          id={id}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={cn(
            "inline-flex items-center justify-center w-4 h-4 rounded border transition-colors",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/60",
            checked
              ? "bg-brand-600 border-brand-600 text-white"
              : "bg-neutral-950 border-neutral-600",
          )}
        >
          {checked && <Check size={12} strokeWidth={3} />}
        </span>
      </span>
      {label && (
        <span className="text-sm leading-5 text-neutral-200">{label}</span>
      )}
      {hint && (
        <span className="col-start-2 text-xs text-faint mt-0.5">
          {hint}
        </span>
      )}
    </label>
  );
}
