import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";

type ToastType = "info" | "success" | "error";

type Toast = {
  id: number;
  message: string;
  type?: ToastType;
  action?: { label: string; onClick: () => void };
};

export type ToastOptions = {
  type?: ToastType;
  /**
   * An inline button on the toast: the undo affordance for reversible bulk
   * actions. Clicking it dismisses the toast.
   */
  action?: { label: string; onClick: () => void };
  /** Override the auto-dismiss delay. Actionable toasts default to longer. */
  durationMs?: number;
};

type ToastCtx = {
  push: (message: string, typeOrOpts?: ToastType | ToastOptions) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

const PLAIN_MS = 2500;
/** Actionable toasts stay longer: an undo you can't reach isn't an undo. */
const ACTION_MS = 7000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, typeOrOpts: ToastType | ToastOptions = "info") => {
      // Accepts the old `push(msg, "success")` shape as well as an options
      // object, so existing call sites keep working unchanged.
      const opts: ToastOptions =
        typeof typeOrOpts === "string" ? { type: typeOrOpts } : typeOrOpts;
      const id = Date.now() + Math.floor(Math.random() * 1000);
      const toast: Toast = {
        id,
        message,
        type: opts.type ?? "info",
        action: opts.action,
      };
      setToasts((list) => [...list, toast]);
      const ms = opts.durationMs ?? (opts.action ? ACTION_MS : PLAIN_MS);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Sits above the selection bar rather than under it. */}
      <div className="fixed bottom-4 right-4 z-[1000] space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "min-w-[240px] max-w-[380px] px-3 py-2 rounded-xl shadow-lg border backdrop-blur",
              "flex items-center gap-3 motion-safe:animate-fade-in",
              t.type === "success"
                ? "bg-emerald-900/70 border-emerald-700 text-emerald-100"
                : t.type === "error"
                  ? "bg-red-900/70 border-red-700 text-red-100"
                  : "bg-neutral-900/85 border-neutral-700 text-neutral-100",
            )}
          >
            <span className="flex-1 text-sm">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 px-2 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide bg-white/10 hover:bg-white/20 transition-colors"
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
