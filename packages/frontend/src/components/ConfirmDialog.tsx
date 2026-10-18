import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Info, Trash2 } from "lucide-react";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";

export type ConfirmTone = "default" | "warning" | "danger";

export type ConfirmOptions = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
};

/** Ask the user to confirm; resolves true on confirm, false on cancel/dismiss. */
export type Confirm = (opts: ConfirmOptions | string) => Promise<boolean>;

const Ctx = createContext<Confirm | null>(null);

const TONE_ICON = {
  default: <Info size={18} className="text-brand-300" />,
  warning: <AlertTriangle size={18} className="text-amber-300" />,
  danger: <Trash2 size={18} className="text-red-300" />,
} as const;

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

/**
 * In-app replacement for `window.confirm`. One dialog at a time: a second
 * request while one is open cancels the first (resolves it false), so a caller
 * is never left awaiting a dialog that was silently replaced.
 */
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(ok);
  }, []);

  const confirm = useCallback<Confirm>((opts) => {
    const o = typeof opts === "string" ? { title: opts } : opts;
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { ...o, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const tone = pending?.tone ?? "default";

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Dialog
        open={!!pending}
        onClose={() => settle(false)}
        labelledBy="confirm-title"
        // Destructive actions start on Cancel so a stray Enter doesn't delete.
        initialFocusRef={tone === "danger" ? cancelBtn : confirmBtn}
        title={
          pending && (
            <span className="flex items-center gap-2">
              {TONE_ICON[tone]}
              {pending.title}
            </span>
          )
        }
        description={pending?.message}
        footer={
          <>
            <Button ref={cancelBtn} onClick={() => settle(false)}>
              {pending?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              ref={confirmBtn}
              variant={tone === "danger" ? "danger" : "primary"}
              onClick={() => settle(true)}
            >
              {pending?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      />
    </Ctx.Provider>
  );
}

/** Outside a provider (isolated component tests) fall back to the native prompt. */
const nativeConfirm: Confirm = async (opts) => {
  if (typeof opts === "string") return window.confirm(opts);
  const msg = typeof opts.message === "string" ? `\n\n${opts.message}` : "";
  return window.confirm(`${opts.title}${msg}`);
};

export function useConfirm(): Confirm {
  return useContext(Ctx) ?? nativeConfirm;
}
