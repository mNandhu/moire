import React from "react";
import { cn } from "../../lib/cn";

// The small pieces every setup step is built from: a step heading, a ruled
// group of fields, a switch row and a status line. Plain on purpose; the
// ring background is the page's one flourish.

export function StepHeading({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <>
      <h2 id={id} className="mb-2 text-[28px] font-semibold leading-tight tracking-tight">
        {title}
      </h2>
      <p className="mb-7 max-w-[56ch] leading-relaxed text-muted">{children}</p>
    </>
  );
}

export function Group({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("border-t border-line py-5 last:border-b", className)}>{children}</div>;
}

export function Help({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} className="mb-3 text-[13px] leading-normal text-faint [&_code]:text-muted">
      {children}
    </p>
  );
}

export function Optional({ children }: { children: React.ReactNode }) {
  return <span className="ml-1.5 text-xs font-normal text-faint">{children}</span>;
}

/** A labelled on/off switch: the whole row is the control. */
export function SwitchRow({
  checked,
  onChange,
  title,
  detail,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  title: React.ReactNode;
  detail?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 text-left disabled:cursor-default"
    >
      <span
        className={cn(
          "relative mt-px h-5 w-[34px] shrink-0 rounded-full transition-colors",
          checked ? "bg-brand-600" : "bg-line-strong",
          disabled && "opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-neutral-100 transition-transform",
            checked && "translate-x-3.5",
          )}
        />
      </span>
      <span>
        <b className={cn("block font-medium", disabled && "text-muted")}>{title}</b>
        {detail && <small className="mt-0.5 block text-[13px] leading-normal text-faint">{detail}</small>}
      </span>
    </button>
  );
}

export type Tone = "busy" | "ok" | "bad" | "off";

export function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      className={cn(
        "h-[7px] w-[7px] shrink-0 rounded-full",
        tone === "busy" && "animate-pulse bg-brand-400",
        tone === "ok" && "bg-emerald-400",
        tone === "bad" && "bg-red-400",
        tone === "off" && "bg-faint",
      )}
    />
  );
}

export function StatusLine({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <div className="mt-2.5 flex items-start gap-2.5 text-[13px] leading-normal text-muted" role="status">
      {/* Centred on the first line, so a message that wraps keeps its dot beside it. */}
      <span className="flex h-[19.5px] items-center">
        <Dot tone={tone} />
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** A text field with its action button inside the same frame. */
export const InlineField = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; action: React.ReactNode; onCommit: () => void }
>(function InlineField({ invalid, action, onCommit, className, ...rest }, ref) {
  return (
    <form
      className={cn(
        "flex h-10 items-center gap-2 rounded-lg border bg-sunken pl-3 pr-1 transition-colors",
        invalid ? "border-red-400" : "border-line-strong focus-within:border-brand-500",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        onCommit();
      }}
    >
      <input
        ref={ref}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        // The frame shows focus (its border), so the input draws no ring of its own.
        className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-neutral-100 outline-none focus-visible:shadow-none"
        {...rest}
      />
      {action}
    </form>
  );
});
