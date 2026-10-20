import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { historyIdx, nextMaxIdx } from "../lib/historyNav";

// Module level: the sidebar unmounts on a standalone image view, and what
// lies ahead in history must survive that.
let maxIdx = historyIdx(typeof window === "undefined" ? null : window.history.state);

/**
 * Follows every navigation. Mounted once in RootRoutes, which renders on
 * every route and before the sidebar, so the sidebar reads a fresh value.
 */
export function useTrackHistory() {
  const { key } = useLocation();
  const action = useNavigationType();
  useMemo(() => {
    maxIdx = nextMaxIdx(maxIdx, historyIdx(window.history.state), action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

type NavigationApi = { canGoBack?: boolean; canGoForward?: boolean };

export function useHistoryNav() {
  useLocation(); // re-render on every navigation
  const navigate = useNavigate();
  const idx = historyIdx(window.history.state);
  // The Navigation API knows the real history, including after a reload.
  const nav = (window as { navigation?: NavigationApi }).navigation;
  const canBack = idx > 0;
  const canForward = nav?.canGoForward ?? idx < maxIdx;
  const back = useCallback(() => navigate(-1), [navigate]);
  const forward = useCallback(() => navigate(1), [navigate]);
  return { canBack, canForward, back, forward };
}
