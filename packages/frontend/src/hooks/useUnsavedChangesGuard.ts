import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * Guards the two exits a page cannot intercept itself: closing the tab and
 * in-app navigation. The third exit (swapping what is being edited) belongs
 * to whoever owns the edit session, since only it knows what "switch" means.
 *
 * One `dirty` flag drives both, so the browser prompt and the router prompt can
 * never disagree about whether there is work to lose. Tab close stays on the
 * browser's native `beforeunload` prompt; it's the only one a page may show
 * there. In-app navigation asks through `confirmLeave` (the app's dialog).
 */
export function useUnsavedChangesGuard(
  dirty: boolean,
  confirmLeave: (opts: {
    title: string;
    message?: string;
    confirmLabel?: string;
    tone?: "default" | "warning" | "danger";
  }) => Promise<boolean> = async ({ title }) => window.confirm(title),
) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Browsers show their own generic copy; preventDefault is what triggers it.
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const blocker = useBlocker(dirty);
  // The blocker object changes identity on every render while blocked; without
  // this latch each re-render would stack another dialog for the same attempt.
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirmLeave({
      title: "Leave with unsaved changes?",
      message: "Your unsaved changes on this page will be lost.",
      confirmLabel: "Leave",
      tone: "warning",
    }).then((ok) => {
      asking.current = false;
      if (ok) blocker.proceed?.();
      else blocker.reset?.();
    });
  }, [blocker, confirmLeave]);
}
