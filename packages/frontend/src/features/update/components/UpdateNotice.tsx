import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpCircle, Check, ChevronUp, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { useDismiss } from "@/hooks/useDismiss";
import { useLocalPref } from "@/hooks/useLocalPref";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toasts";
import { useVersionStatus, type VersionStatus } from "@/features/update/lib/version";

function CommandLine({ command, compact = false }: { command: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const { push } = useToast();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      // Undefined over plain http to another device (not a secure context).
      await navigator.clipboard.writeText(command);
    } catch {
      push("Couldn't copy to the clipboard", "error");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-sunken py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 break-words py-1 font-mono text-[12.5px] text-neutral-100">{command}</code>
      <Button size={compact ? "iconSm" : "sm"} variant="ghost" onClick={() => void copy()} aria-label="Copy command">
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {!compact && (copied ? "Copied" : "Copy")}
      </Button>
    </div>
  );
}

/** What a waiting update says, in the sidebar and in Settings > About. */
export function UpdateDetails({
  status,
  onLater,
  compact,
  showCurrent = true,
}: {
  status: VersionStatus;
  onLater?: () => void;
  compact?: boolean;
  /** "You have 0.2.1." (off where the version is already shown). */
  showCurrent?: boolean;
}) {
  return (
    <div className="space-y-3 text-[13px] text-muted">
      <div>
        <div className="font-medium text-neutral-100">Moiré {status.latest} is out</div>
        {showCurrent && <div>You have {status.current}.</div>}
      </div>
      {status.command && (
        <div className="space-y-1.5">
          <div>{status.install_kind === "docker" ? "In the Moiré folder, run:" : "Close Moiré, then run:"}</div>
          <CommandLine command={status.command} compact={compact} />
        </div>
      )}
      <div className="flex items-center gap-2">
        {status.release_url && (
          <a
            href={status.release_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-brand-300 hover:text-brand-200"
          >
            What's new <ExternalLink size={13} />
          </a>
        )}
        {onLater && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onLater}>
            Later
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The sidebar's "Update available" row, above Settings: unfolds in place like
 * the background-work line (a popover when the sidebar is collapsed). "Later"
 * hides it until the next release; Settings > About still shows it.
 */
export function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const { data: status } = useVersionStatus();
  const latest = status?.latest ?? "";
  // The release "Later" was pressed on: a newer one shows again.
  const [dismissedFor, setDismissedFor] = useLocalPref<string>("update:dismissed", "");
  const dismissed = dismissedFor === latest;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  if (!status?.update_available || dismissed) return null;

  const later = () => {
    setOpen(false);
    setDismissedFor(latest);
  };

  if (collapsed) {
    return (
      <>
        <button
          ref={btnRef}
          type="button"
          aria-label={`Update available: ${latest}`}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="w-full flex justify-center py-2 text-brand-300 rounded-lg hover:bg-raised/60"
        >
          <ArrowUpCircle size={18} />
        </button>
        {open && (
          <Popover anchor={btnRef} onClose={() => setOpen(false)}>
            <UpdateDetails status={status} onLater={later} />
          </Popover>
        )}
      </>
    );
  }
  return (
    <div>
      {open && (
        <div className="mb-1 rounded-lg border border-line bg-surface p-3">
          <UpdateDetails status={status} onLater={later} compact />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-brand-200 hover:bg-raised/60"
      >
        <ArrowUpCircle size={14} className="shrink-0 text-brand-300" />
        <span className="min-w-0 flex-1 truncate">Update available</span>
        <span className="shrink-0 tabular-nums text-faint">{latest}</span>
        <ChevronUp size={14} className={cn("shrink-0 transition-transform text-faint", !open && "rotate-180")} />
      </button>
    </div>
  );
}

/** A panel beside the collapsed rail's button. Portalled: the sidebar clips
 * overflow. */
function Popover({
  anchor,
  onClose,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useDismiss([ref, anchor], onClose, true);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const h = ref.current?.offsetHeight ?? 0;
    setPos({ top: Math.max(8, Math.min(r.top, window.innerHeight - h - 8)), left: r.right + 10 });
  }, [anchor]);
  return createPortal(
    <div
      ref={ref}
      style={pos ?? { visibility: "hidden" }}
      className="fixed z-50 w-80 rounded-xl border border-line bg-surface p-4 shadow-panel"
    >
      {children}
    </div>,
    document.body,
  );
}
